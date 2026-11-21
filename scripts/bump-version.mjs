#!/usr/bin/env node
/**
 * Version injection helper for AgentUI releases.
 *
 * Usage:
 *   node scripts/bump-version.mjs --print
 *   node scripts/bump-version.mjs 0.2.0
 *   node scripts/bump-version.mjs patch | minor | major
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const ROOT = resolve(process.cwd())
const PKG_PATH = resolve(ROOT, 'package.json')
const LOCK_PATH = resolve(ROOT, 'package-lock.json')

const SEMVER_RE = /^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

function writeJson(path, obj) {
  writeFileSync(path, `${JSON.stringify(obj, null, 2)}\n`, 'utf8')
}

function nextVersion(current, arg) {
  if (arg === 'patch' || arg === 'minor' || arg === 'major') {
    const m = current.match(SEMVER_RE)
    if (!m) throw new Error(`Current version is not valid semver: ${current}`)
    let major = Number(m[1])
    let minor = Number(m[2])
    let patch = Number(m[3])
    if (arg === 'major') {
      major += 1
      minor = 0
      patch = 0
    } else if (arg === 'minor') {
      minor += 1
      patch = 0
    } else {
      patch += 1
    }
    return `${major}.${minor}.${patch}`
  }
  if (!SEMVER_RE.test(arg)) {
    throw new Error(`Invalid version "${arg}". Expected semver (e.g. 0.2.0) or patch|minor|major.`)
  }
  return arg
}

const arg = process.argv[2]
const pkg = readJson(PKG_PATH)

if (!arg || arg === '--print') {
  console.log(pkg.version)
  process.exit(0)
}

const updated = nextVersion(pkg.version, arg)
const prev = pkg.version
pkg.version = updated
writeJson(PKG_PATH, pkg)

if (existsSync(LOCK_PATH)) {
  const lock = readJson(LOCK_PATH)
  lock.version = updated
  if (lock.packages && lock.packages['']) {
    lock.packages[''].version = updated
  }
  writeJson(LOCK_PATH, lock)
}

console.log(`AgentUI version updated: ${prev} -> ${updated}`)
