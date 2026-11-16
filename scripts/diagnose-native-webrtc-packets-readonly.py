"""Bounded WebRTC wire counters. No pcap file, payload output or config changes.

Run on the authorized VoIP host with Python 3 and tcpdump. Counters cover eth0
UDP media ports 13001..14000 and ICMPv6 Packet Too Big for up to 180 seconds.
SRTP's visible RTP header is inspected; media/DTLS payloads are never exported.
"""
import collections
import datetime
import json
import struct
import subprocess
import threading
import time
import ipaddress


def now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


flows = {}
errors = []
lock = threading.Lock()


def read_exact(stream, count):
    result = b""
    while len(result) < count:
        chunk = stream.read(count - len(result))
        if not chunk:
            raise EOFError()
        result += chunk
    return result


def packet(frame, wire_size):
    if len(frame) < 14:
        return
    offset, proto = 14, struct.unpack_from("!H", frame, 12)[0]
    while proto in (0x8100, 0x88a8):
        if len(frame) < offset + 4:
            return
        proto = struct.unpack_from("!H", frame, offset + 2)[0]
        offset += 4
    if proto == 0x0800 and len(frame) >= offset + 20:
        family = 4
        source = str(ipaddress.ip_address(frame[offset + 12:offset + 16]))
        destination = str(ipaddress.ip_address(frame[offset + 16:offset + 20]))
        transport = frame[offset + 9]
        offset += (frame[offset] & 15) * 4
    elif proto == 0x86dd and len(frame) >= offset + 40:
        family = 6
        source = str(ipaddress.ip_address(frame[offset + 8:offset + 24]))
        destination = str(ipaddress.ip_address(frame[offset + 24:offset + 40]))
        transport = frame[offset + 6]
        offset += 40
    else:
        return
    if transport == 58 and len(frame) >= offset + 8 and frame[offset] == 2:
        with lock:
            errors.append({"at": now(), "type": "icmpv6_packet_too_big",
                           "mtu": struct.unpack_from("!I", frame, offset + 4)[0]})
        return
    if transport != 17 or len(frame) < offset + 8:
        return
    source_port, destination_port = struct.unpack_from("!HH", frame, offset)
    local_addresses = {"192.168.0.50", "2803:9810:4c5e:9b00::50", "2804:45bc:8000::50"}
    if not ((source in local_addresses and 13001 <= source_port <= 14000)
            or (destination in local_addresses and 13001 <= destination_port <= 14000)):
        return
    header = frame[offset + 8:offset + 20]  # RTP header only, never audio bytes.
    kind = "other_udp"
    if len(header) >= 8 and header[0] < 4 and header[4:8] == b"\x21\x12\xa4\x42":
        kind = "stun"
    elif len(header) >= 3 and 20 <= header[0] <= 63 and header[1] == 0xfe:
        kind = "dtls"
    elif len(header) >= 12 and header[0] >> 6 == 2:
        kind = "rtcp" if 192 <= header[1] <= 223 else "rtp"
    key = (family, source, source_port, destination, destination_port)
    with lock:
        flow = flows.setdefault(key, {"family": family, "source": source, "sourcePort": source_port,
                                     "destination": destination, "destinationPort": destination_port,
                                     "counts": collections.Counter(), "rtpSsrcs": {},
                                     "minWireBytes": wire_size, "maxWireBytes": wire_size})
        flow["counts"][kind] += 1
        flow["minWireBytes"] = min(flow["minWireBytes"], wire_size)
        flow["maxWireBytes"] = max(flow["maxWireBytes"], wire_size)
        if kind == "rtp":
            ssrc = "%08x" % struct.unpack_from("!I", header, 8)[0]
            value = flow["rtpSsrcs"].setdefault(ssrc, {"payloadType": header[1] & 127, "packets": 0})
            value["packets"] += 1


def capture(process):
    try:
        stream = process.stdout
        header = read_exact(stream, 24)
        endian = "<" if header[:4] == b"\xd4\xc3\xb2\xa1" else ">"
        if struct.unpack_from(endian + "I", header, 20)[0] != 1:
            raise ValueError("ethernet_capture_required")
        while True:
            _, _, captured, wire = struct.unpack(endian + "IIII", read_exact(stream, 16))
            if captured > 65536:
                raise ValueError("capture_record_too_large")
            packet(read_exact(stream, captured), wire)
    except EOFError:
        pass
    except Exception as error:
        with lock:
            errors.append({"type": type(error).__name__})


def snapshot(stage):
    with lock:
        print(json.dumps({"probe": stage, "at": now(), "flows": list(flows.values()),
                          "errors": list(errors)}, indent=1), flush=True)


process = subprocess.Popen(["tcpdump", "-n", "-p", "-i", "eth0", "-s", "96", "-U", "-w", "-",
                            "udp portrange 13001-14000 or (icmp6 and ip6[40] == 2)"],
                           stdout=subprocess.PIPE, stderr=subprocess.PIPE)
try:
    threading.Thread(target=capture, args=(process,), daemon=True).start()
    print(json.dumps({"probe": "ready", "at": now(), "durationSeconds": 180,
                      "interface": "eth0", "promiscuous": False, "payloadExported": False}), flush=True)
    for _ in range(36):
        time.sleep(5)
        if process.poll() is not None:
            raise RuntimeError("capture_process_stopped")
        snapshot("sample")
finally:
    process.terminate()
    process.wait(timeout=5)
    snapshot("final")
