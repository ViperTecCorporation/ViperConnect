"""Run on the VPS. Narrow dependency-only hotpatch; keeps rollback material."""
import json
import pathlib
import subprocess
import sys
import yaml

ROOT = pathlib.Path('/var/snap/docker/common/viperconnect-hotpatch/zapo-1.9.0-20260922')
BASE = pathlib.Path('/var/snap/docker/common/var-lib-docker/volumes/portainer_data/_data/compose/21/docker-compose.yml')
SERVICES = ['unoapi', 'unoapi-broker', 'unoapi-video-worker', 'unoapi-worker-zapo']

def run(*args):
    return subprocess.check_output(args, text=True)

def compose(*args):
    return run('docker', 'compose', '-p', 'unoapi', '-f', str(ROOT / 'base.yml'), *args)

def calls():
    source = '''fetch(process.env.VOIP_SERVICE_URL+'/v1/zapo/calls', {headers:{Authorization:'Bearer '+process.env.VOIP_SERVICE_TOKEN}}).then(async r=>{if(!r.ok)throw Error('calls_http_'+r.status); console.log(JSON.stringify(await r.json()))}).catch(e=>{console.error(e.message);process.exit(1)})'''
    return json.loads(run('docker', 'exec', 'unoapi', 'node', '-e', source))['calls']

mode = sys.argv[1]
if mode == 'prepare':
    assert not (ROOT / 'base.yml').exists(), 'Already prepared'
    ROOT.mkdir(parents=True, exist_ok=True)
    ROOT.chmod(0o700)
    content = BASE.read_text()
    assert '${' not in content.replace('$$', ''), 'Environment interpolation needs review'
    config = yaml.safe_load(content)
    for name in SERVICES:
        assert config['services'][name]['image'].endswith(':4.0.32')
        current = json.loads(run('docker', 'inspect', name))[0]
        assert not current['Mounts'], 'Existing mounts need reconciliation'
    (ROOT / 'base.yml').write_text(content)
    (ROOT / 'base.yml').chmod(0o600)
    override = {'services': {name: {'volumes': [str(ROOT / 'zapo-js') + ':/home/u/app/node_modules/zapo-js:ro']} for name in SERVICES}}
    (ROOT / 'override.yml').write_text(yaml.safe_dump(override))
    (ROOT / 'rollback.sh').write_text('#!/bin/sh\nset -eu\ndocker compose -p unoapi -f '+str(ROOT / 'base.yml')+' up -d --no-deps --pull never --force-recreate '+' '.join(SERVICES)+'\n')
    (ROOT / 'rollback.sh').chmod(0o700)
    run('docker', 'cp', 'unoapi-worker-zapo:/home/u/app/node_modules/zapo-js', str(ROOT / 'zapo-js-1.8.2-backup'))
    print('Prepared; original image and dependency backup retained')
elif mode == 'apply':
    assert not calls(), 'Active calls: postpone restart'
    assert json.loads((ROOT / 'zapo-js/package.json').read_text())['version'] == '1.9.0'
    # The container user must traverse the mount source; keep private base config protected.
    ROOT.chmod(0o755)
    print(compose('-f', str(ROOT / 'override.yml'), 'up', '-d', '--no-deps', '--pull', 'never', '--force-recreate', *SERVICES))
    for name in SERVICES:
        print(name, run('docker', 'exec', name, 'node', '-e', "console.log(require('./node_modules/zapo-js/package.json').version)").strip())
else:
    raise SystemExit('Expected prepare or apply')
