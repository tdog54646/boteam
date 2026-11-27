import { execFileSync } from 'node:child_process'
import { createPrivateKey, generateKeyPairSync, X509Certificate } from 'node:crypto'
import { linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { localSigningTool } from './mac-signing-tool.mjs'

export const bundleId = 'local.boteam.desktop'
const localDirectory = join(homedir(), 'Library', 'Application Support', 'BoTeam Build')

function createIdentity(directory, identity) {
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 3072,
    privateKeyEncoding: { format: 'pem', type: 'pkcs8' },
    publicKeyEncoding: { format: 'pem', type: 'spki' },
  })
  const staging = mkdtempSync(join(directory, '.identity-'))
  try {
    const config = join(staging, 'openssl.cnf')
    writeFileSync(config, '[req]\ndistinguished_name=subject\n[subject]\nCN=BoTeam Local Build\n')
    const certificate = execFileSync('/usr/bin/openssl', [
      'req', '-new', '-x509', '-sha256', '-days', '7300', '-config', config,
      '-subj', '/CN=BoTeam Local Build', '-key', '/dev/stdin',
      '-addext', 'basicConstraints=critical,CA:FALSE', '-addext', 'keyUsage=critical,digitalSignature',
      '-addext', 'extendedKeyUsage=codeSigning',
    ], { input: privateKey, encoding: 'utf8' })
    const candidate = join(staging, 'identity.pem')
    writeFileSync(candidate, certificate + privateKey, { mode: 0o600, flag: 'wx' })
    // Publish the complete pair only once, including when two first builds race.
    try { linkSync(candidate, identity) } catch (error) {
      if (error.code !== 'EEXIST') throw error
    }
  } finally {
    rmSync(staging, { recursive: true, force: true })
  }
}

function localIdentity() {
  mkdirSync(localDirectory, { recursive: true, mode: 0o700 })
  const identity = join(localDirectory, 'identity.pem')
  let info = lstatSync(identity, { throwIfNoEntry: false })
  if (!info) {
    createIdentity(localDirectory, identity)
    info = lstatSync(identity)
  }
  if (!info.isFile() || info.uid !== process.getuid() || (info.mode & 0o077)) {
    throw new Error(`签名文件必须归当前用户所有，权限为 600：${identity}`)
  }
  const pem = readFileSync(identity)
  const certificate = new X509Certificate(pem)
  if (!certificate.checkPrivateKey(createPrivateKey(pem))) throw new Error('BoTeam 本机签名证书与私钥不匹配')
  return { identity, fingerprint: certificate.fingerprint.replaceAll(':', '') }
}

export async function macSigning() {
  const developerIdentity = process.env.BOTEAM_MAC_SIGN_IDENTITY?.trim()
  const identifier = `identifier "${bundleId}"`
  if (developerIdentity === '-') throw new Error('BoTeam 的钥匙串授权需要固定签名身份')
  if (developerIdentity) {
    return {
      osxSign: { identity: developerIdentity, continueOnError: false },
      verifyRequirement: identifier + ' and anchor apple generic and certificate leaf[field.1.2.840.113635.100.6.1.13] exists',
    }
  }
  const tool = await localSigningTool()
  const { identity, fingerprint } = localIdentity()
  return {
    sign(bundle) {
      execFileSync(tool, ['sign', '--pem-file', identity, '--timestamp-url', 'none', bundle], { stdio: 'inherit' })
    },
    verifyRequirement: identifier + ` and certificate leaf = H"${fingerprint}"`,
  }
}

export function verifyMacSignature(bundle, requirement) {
  execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', '-R=' + requirement, bundle], {
    stdio: 'inherit',
  })
}
