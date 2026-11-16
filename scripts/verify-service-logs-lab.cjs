// Execute in the existing DEV web container; reads only an explicitly synthetic log target.
const assert = require('node:assert/strict')
const component = 'dddddddddddddddddddddddd', base = 'http://127.0.0.1:9876'
const headers = { Authorization: `Bearer ${process.env.UNOAPI_AUTH_TOKEN}` }
async function sample(query, count = 4) {
  const abort = new AbortController(), timeout = setTimeout(() => abort.abort(), 10000)
  let reader
  try {
    const response = await fetch(`${base}/admin/resources/${component}/logs?${query}`, { headers, signal: abort.signal })
    assert.equal(response.status, 200)
    assert.match(response.headers.get('content-type'), /application\/x-ndjson/)
    reader = response.body.getReader(); const decoder = new TextDecoder(), lines = []; let pending = ''
    while (lines.length < count) {
      const next = await reader.read(); if (next.done) break
      pending += decoder.decode(next.value, { stream: true })
      let end
      while ((end = pending.indexOf('\n')) >= 0) {
        const text = pending.slice(0, end); pending = pending.slice(end + 1)
        if (!text) continue
        const value = JSON.parse(text)
        if (value.type === 'error') throw new Error(value.error)
        if (value.type === 'line') lines.push(value.line)
      }
    }
    assert.ok(lines.length >= count)
    assert.doesNotMatch(JSON.stringify(lines), /FAKE_PRIVATE_PASSWORD|FAKE_PRIVATE_TOKEN|FAKE_PRIVATE_KEY/)
    return lines
  } finally { clearTimeout(timeout); await reader?.cancel().catch(() => {}); abort.abort() }
}
;(async () => {
  assert.ok([401, 403].includes((await fetch(`${base}/admin/resources/${component}/logs`)).status))
  const all = await sample('tail=100')
  assert.ok(all.some(line => line.channel === 'stdout')); assert.ok(all.some(line => line.channel === 'stderr'))
  const errors = await sample('tail=100&include=probe-error&level=error&channel=stderr')
  assert.ok(errors.every(line => line.channel === 'stderr' && line.level === 'error' && line.text.includes('probe-error')))
  const info = await sample('tail=100&include=probe-info&exclude=probe-error&channel=stdout')
  assert.ok(info.every(line => line.text.includes('áudio') && !line.text.includes('probe-error')))
  for (let i = 0; i < 8; i++) { await sample('tail=1', 1); await new Promise(resolve => setTimeout(resolve, 25)) }
  console.log(JSON.stringify({ passed: true, checks: ['admin-only', 'docker-multiplex', 'utf8', 'include-exclude', 'minimum-level', 'channel', 'redaction', 'eight-disconnects-without-slot-leak'], allLines: all.length, errorLines: errors.length, infoLines: info.length }))
})().catch(error => { console.error(error.message); process.exitCode = 1 })
