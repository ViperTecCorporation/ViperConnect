import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'fs'
import { join } from 'path'
import { spawnSync } from 'child_process'

const log = (...args) => console.log('[prepare-baileys]', ...args)
const warn = (...args) => console.warn('[prepare-baileys]', ...args)
const isPostinstall = process.env.npm_lifecycle_event === 'postinstall'

const exitFailure = () => {
  process.exit(isPostinstall ? 0 : 1)
}

const run = (cmd, args, cwd) => {
  try {
    return spawnSync(cmd, args, {
      cwd,
      stdio: 'inherit',
      shell: process.platform === 'win32'
    })
  } catch (error) {
    return { status: null, error }
  }
}

const runWithFallback = (variants, cwd) => {
  for (const [cmd, args] of variants) {
    const res = run(cmd, args, cwd)
    if (res.status === 0) return true
  }
  return false
}

const patchFile = (filePath, replacer) => {
  if (!existsSync(filePath)) return false
  const before = readFileSync(filePath, 'utf8')
  const after = replacer(before)
  if (!after || after === before) return false
  writeFileSync(filePath, after)
  return true
}

const patchBaileysCompat = (modDir) => {
  const cryptoPath = join(modDir, 'lib', 'Utils', 'crypto.js')
  const chatUtilsPath = join(modDir, 'lib', 'Utils', 'chat-utils.js')
  const ltHashPath = join(modDir, 'lib', 'Utils', 'lt-hash.js')
  const reportingUtilsPath = join(modDir, 'lib', 'Utils', 'reporting-utils.js')

  const patchedCrypto = patchFile(cryptoPath, (src) => {
    let out = src
    if (!out.includes('hkdfSync')) {
      out = out.replace(
        `import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from 'crypto';`,
        `import { createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, randomBytes } from 'crypto';`
      )
    }
    if (out.includes(`export { md5, hkdf } from 'whatsapp-rust-bridge';`)) {
      out = out.replace(
        `export { md5, hkdf } from 'whatsapp-rust-bridge';`,
        `// [unoapi-compat] rust-bridgeless crypto\nexport function md5(buffer) {\n    return createHash('md5').update(buffer).digest();\n}\nexport function hkdf(buffer, expandedLength, info = {}) {\n    const ikm = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);\n    const salt = info?.salt ? Buffer.from(info.salt) : Buffer.alloc(0);\n    const inf = info?.info ? Buffer.from(info.info) : Buffer.alloc(0);\n    return Buffer.from(hkdfSync('sha256', ikm, salt, inf, expandedLength));\n}`
      )
    } else if (out.includes('export async function hkdf(') && !out.includes('[unoapi-compat] sync hkdf')) {
      out = out.replace(
        /export async function hkdf\([\s\S]*?\n}\nexport async function derivePairingCodeKey\(/,
        `// [unoapi-compat] sync hkdf to avoid Promise leaks in callers expecting Buffer\nexport function hkdf(buffer, expandedLength, info = {}) {\n    const ikm = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);\n    const salt = info?.salt ? Buffer.from(info.salt) : Buffer.alloc(0);\n    const inf = info?.info ? Buffer.from(info.info) : Buffer.alloc(0);\n    return Buffer.from(hkdfSync('sha256', ikm, salt, inf, expandedLength));\n}\nexport async function derivePairingCodeKey(`
      )
    }
    return out
  })

  const patchedChatUtils = patchFile(chatUtilsPath, (src) => {
    if (src.includes('[unoapi-compat] local expandAppStateKeys')) return src
    if (!src.includes(`import { expandAppStateKeys } from 'whatsapp-rust-bridge';`)) return src
    return src
      .replace(`import { expandAppStateKeys } from 'whatsapp-rust-bridge';\n`, '')
      .replace(
        `import { aesDecrypt, aesEncrypt, hmacSign } from './crypto.js';`,
        `import { aesDecrypt, aesEncrypt, hkdf, hmacSign } from './crypto.js';`
      )
      .replace(
        `const mutationKeys = (keydata) => {\n    const keys = expandAppStateKeys(keydata);\n    return {\n        indexKey: keys.indexKey,\n        valueEncryptionKey: keys.valueEncryptionKey,\n        valueMacKey: keys.valueMacKey,\n        snapshotMacKey: keys.snapshotMacKey,\n        patchMacKey: keys.patchMacKey\n    };\n};`,
        `// [unoapi-compat] local expandAppStateKeys (no whatsapp-rust-bridge)\nconst expandAppStateKeys = (keydata) => {\n    const expanded = hkdf(keydata, 160, { info: 'WhatsApp Mutation Keys' });\n    return {\n        indexKey: expanded.slice(0, 32),\n        valueEncryptionKey: expanded.slice(32, 64),\n        valueMacKey: expanded.slice(64, 96),\n        snapshotMacKey: expanded.slice(96, 128),\n        patchMacKey: expanded.slice(128, 160)\n    };\n};\nconst mutationKeys = (keydata) => {\n    const keys = expandAppStateKeys(keydata);\n    return {\n        indexKey: keys.indexKey,\n        valueEncryptionKey: keys.valueEncryptionKey,\n        valueMacKey: keys.valueMacKey,\n        snapshotMacKey: keys.snapshotMacKey,\n        patchMacKey: keys.patchMacKey\n    };\n};`
      )
  })

  const patchedLtHash = patchFile(ltHashPath, (src) => {
    if (src.includes('[unoapi-compat] rust-bridgeless LT hash')) return src
    if (!src.includes(`from 'whatsapp-rust-bridge'`)) return src
    return `import { hkdf } from './crypto.js';\n// [unoapi-compat] rust-bridgeless LT hash\nclass LTHashCompat {\n    constructor(salt) {\n        this.salt = salt;\n    }\n    add(hashBuffer, values) {\n        for (const value of values) {\n            hashBuffer = this._addSingle(hashBuffer, value);\n        }\n        return hashBuffer;\n    }\n    subtract(hashBuffer, values) {\n        for (const value of values) {\n            hashBuffer = this._subtractSingle(hashBuffer, value);\n        }\n        return hashBuffer;\n    }\n    subtractThenAdd(hashBuffer, subtractValues, addValues) {\n        const subtracted = this.subtract(hashBuffer, subtractValues);\n        return this.add(subtracted, addValues);\n    }\n    _addSingle(hashBuffer, value) {\n        const derived = hkdf(Buffer.from(value), 128, { info: this.salt });\n        return this.performPointwiseWithOverflow(hashBuffer, derived, (a, b) => a + b);\n    }\n    _subtractSingle(hashBuffer, value) {\n        const derived = hkdf(Buffer.from(value), 128, { info: this.salt });\n        return this.performPointwiseWithOverflow(hashBuffer, derived, (a, b) => a - b);\n    }\n    performPointwiseWithOverflow(current, delta, op) {\n        const currentView = Buffer.isBuffer(current) ? current : Buffer.from(current);\n        const deltaView = Buffer.isBuffer(delta) ? delta : Buffer.from(delta);\n        const out = Buffer.alloc(currentView.length);\n        for (let i = 0; i < currentView.length; i += 2) {\n            const a = currentView.readUInt16LE(i);\n            const b = deltaView.readUInt16LE(i);\n            out.writeUInt16LE(op(a, b) & 0xffff, i);\n        }\n        return out;\n    }\n}\nexport const LT_HASH_ANTI_TAMPERING = new LTHashCompat('WhatsApp Patch Integrity');\n`
  })

  const patchedReporting = patchFile(reportingUtilsPath, (src) => {
    let out = src
    if (out.includes('const generateMsgSecretKey = async')) {
      out = out.replace(
        'const generateMsgSecretKey = async (modificationType, origMsgId, origMsgSender, modificationSender, origMsgSecret) => {',
        'const generateMsgSecretKey = (modificationType, origMsgId, origMsgSender, modificationSender, origMsgSecret) => {'
      )
    }
    if (!out.includes('[unoapi-compat] normalize reporting secret') && out.includes('const reportingSecret = await generateMsgSecretKey(ENC_SECRET_REPORT_TOKEN, key.id, from, to, msgSecret);')) {
      out = out.replace(
        `const reportingSecret = await generateMsgSecretKey(ENC_SECRET_REPORT_TOKEN, key.id, from, to, msgSecret);`,
        `const reportingSecretRaw = await generateMsgSecretKey(ENC_SECRET_REPORT_TOKEN, key.id, from, to, msgSecret);\n    // [unoapi-compat] normalize reporting secret\n    const reportingSecret = (reportingSecretRaw && typeof reportingSecretRaw?.then === 'function')\n        ? await reportingSecretRaw\n        : reportingSecretRaw;`
      )
    }
    if (!out.includes('[unoapi-compat] harden reporting token key')) {
      out = out.replace(
        `const reportingToken = createHmac('sha256', reportingSecret).update(content).digest().subarray(0, 16);`,
        `// [unoapi-compat] harden reporting token key\n    const reportingSecretKeyRaw = (reportingSecret && typeof reportingSecret?.then === 'function') ? await reportingSecret : reportingSecret;\n    const reportingSecretKey = Buffer.isBuffer(reportingSecretKeyRaw)\n        ? reportingSecretKeyRaw\n        : Buffer.from(reportingSecretKeyRaw || '');\n    const reportingToken = createHmac('sha256', reportingSecretKey).update(content).digest().subarray(0, 16);`
      )
    }
    return out
  })

  if (patchedCrypto || patchedChatUtils || patchedLtHash || patchedReporting) {
    log('compat patch aplicado para evitar TLA do whatsapp-rust-bridge')
  }
}

const walkFiles = (dir, predicate, files = []) => {
  if (!existsSync(dir)) return files
  for (const entry of readdirSync(dir)) {
    const fullPath = join(dir, entry)
    const stat = statSync(fullPath)
    if (stat.isDirectory()) {
      walkFiles(fullPath, predicate, files)
    } else if (predicate(fullPath)) {
      files.push(fullPath)
    }
  }
  return files
}

const patchBaileysDeclarations = (modDir) => {
  const declarationRoots = [
    join(modDir, 'lib'),
    join(modDir, 'WAProto')
  ]
  let patched = 0
  for (const root of declarationRoots) {
    for (const filePath of walkFiles(root, (file) => file.endsWith('.d.ts'))) {
      const changed = patchFile(filePath, (src) => {
        let out = src
          .replace(/@whiskeysockets\/baileys\/src\//g, '@whiskeysockets/baileys/lib/')
          .replace(/from ['"](\.\.\/\.\.\/WAProto)['"]/g, `from '$1/index.js'`)
        return out
      })
      if (changed) patched += 1
    }
  }
  if (patched) {
    log(`declarations ajustadas para apontar para lib/ (${patched} arquivos)`)
  }
}

try {
  const root = process.cwd()
  const modDir = join(root, 'node_modules', '@whiskeysockets', 'baileys')
  const pkgPath = join(modDir, 'package.json')

  if (!existsSync(pkgPath)) {
    log('baileys nao encontrado em node_modules, nada a fazer')
    process.exit(0)
  }

  // Heuristicas de artefatos compilados
  const libIndex = join(modDir, 'lib', 'index.js')
  const libTypes = join(modDir, 'lib', 'index.d.ts')
  const distIndex = join(modDir, 'dist', 'index.js')
  const socketIdxCandidates = [
    join(modDir, 'lib', 'Socket', 'index.js'),
    join(modDir, 'lib', 'Socket', 'index.cjs'),
    join(modDir, 'lib', 'Socket', 'index.mjs')
  ]
  const hasLibIndex = existsSync(libIndex)
  const hasLibTypes = existsSync(libTypes)
  const hasDistIndex = existsSync(distIndex)
  const hasSocketIdx = socketIdxCandidates.some(existsSync)

  if ((hasLibIndex || hasDistIndex) && hasSocketIdx && hasLibTypes) {
    patchBaileysDeclarations(modDir)
    patchBaileysCompat(modDir)
    log('artefatos ja presentes (lib/dist + Socket), skip build')
    process.exit(0)
  }

  // Preparar tsconfig local para emitir JS e declarations mesmo se a Baileys
  // reportar erros de tipagem internos durante a geracao dos artefatos.
  const tsconfigBuild = [
    join(modDir, 'tsconfig.build.json'),
    join(modDir, 'tsconfig.json')
  ].find(existsSync)

  if (!tsconfigBuild) {
    warn('tsconfig do baileys nao encontrado; abortando prepare')
    process.exit(0)
  }

  try {
    const cfg = JSON.parse(readFileSync(tsconfigBuild, 'utf8'))
    cfg.compilerOptions = cfg.compilerOptions || {}
    // O package da Baileys aponta "types" para lib/index.d.ts. Em build limpo do
    // Docker, sem esses .d.ts, o tsc do Uno nao resolve @whiskeysockets/baileys.
    cfg.compilerOptions.declaration = true
    cfg.compilerOptions.declarationMap = false
    cfg.compilerOptions.skipLibCheck = true
    cfg.compilerOptions.strict = false
    cfg.compilerOptions.noEmitOnError = false
    const localCfg = join(modDir, 'tsconfig.build.local.json')
    writeFileSync(localCfg, JSON.stringify(cfg, null, 2))

    // Compilar TS -> JS usando primeiro as ferramentas do projeto raiz.
    // Evita instalar devDependencies da Baileys com Yarn 1, que quebra em
    // alguns package.json modernos com packageManager Yarn 4.
    const rootTsc = join(root, 'node_modules', 'typescript', 'bin', 'tsc')
    runWithFallback([
      [process.execPath, [rootTsc, '-p', localCfg]],
      ['yarn', ['tsc', '-p', localCfg]],
      ['corepack', ['yarn', 'tsc', '-p', localCfg]],
      ['npx', ['-y', 'tsc', '-p', localCfg]]
    ], modDir)

    // Ajustar imports ESM
    const rootTscEsmFix = join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'tsc-esm-fix.cmd' : 'tsc-esm-fix')
    const esmFixVariants = []
    if (existsSync(rootTscEsmFix)) {
      esmFixVariants.push([rootTscEsmFix, [`--tsconfig=${localCfg}`, '--ext=.js']])
    }
    esmFixVariants.push(
      ['yarn', ['tsc-esm-fix', `--tsconfig=${localCfg}`, '--ext=.js']],
      ['corepack', ['yarn', 'tsc-esm-fix', `--tsconfig=${localCfg}`, '--ext=.js']],
      ['npx', ['-y', 'tsc-esm-fix', `--tsconfig=${localCfg}`, '--ext=.js']]
    )
    runWithFallback([
      ...esmFixVariants
    ], modDir)

    patchBaileysDeclarations(modDir)
    patchBaileysCompat(modDir)
  } catch (e) {
    warn('falha ao ajustar/compilar tsconfig local:', e?.message || e)
  }

  // Checagem final
  const finalHasLibIndex = existsSync(libIndex)
  const finalHasLibTypes = existsSync(libTypes)
  const finalHasLoggerTypes = existsSync(join(modDir, 'lib', 'Utils', 'logger.d.ts'))
  const finalHasSocketIdx = socketIdxCandidates.some(existsSync)
  if (finalHasLibIndex && finalHasSocketIdx && finalHasLibTypes && finalHasLoggerTypes) {
    log('baileys compilado e arquivos esperados presentes')
  } else {
    warn('baileys pode nao estar completamente compilado (lib/index.js, lib/index.d.ts, lib/Utils/logger.d.ts ou lib/Socket/index ausente).')
    exitFailure()
  }
} catch (err) {
  warn('erro no prepare-baileys:', err?.message || err)
  exitFailure()
}
