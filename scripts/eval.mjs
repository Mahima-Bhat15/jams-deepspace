#!/usr/bin/env node
/**
 * Extraction eval against the deployed app.
 *
 *   node scripts/eval.mjs <app-name>
 *
 * Sends each fixture in scripts/eval-fixtures.json to the app's `jams_preview`
 * agent tool (a dry run that writes nothing) through `npx deepspace agent invoke`,
 * which reuses your CLI login. A fixture passes when every expected ticket is
 * found (title contains one of its keywords AND the owner matches exactly) and
 * no extra tickets appear.
 */

import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const app = process.argv[2]
if (!app) {
  console.error('usage: node scripts/eval.mjs <app-name>')
  process.exit(2)
}

const fixtures = JSON.parse(readFileSync(new URL('./eval-fixtures.json', import.meta.url), 'utf8'))
const dir = mkdtempSync(join(tmpdir(), 'jams-eval-'))

/** The CLI wraps tool output; find the object that carries `creates`. */
function findPlan(node) {
  if (!node || typeof node !== 'object') return null
  if (Array.isArray(node.creates)) return node
  for (const v of Object.values(node)) {
    if (typeof v === 'string' && v.includes('"creates"')) {
      try {
        const hit = findPlan(JSON.parse(v))
        if (hit) return hit
      } catch {
        /* not JSON */
      }
    }
    const hit = findPlan(v)
    if (hit) return hit
  }
  return null
}

let passed = 0
let expectedTotal = 0
let found = 0
let extras = 0

for (const [i, fx] of fixtures.entries()) {
  const file = join(dir, `fx${i}.json`)
  writeFileSync(file, JSON.stringify({ messages: fx.messages }))
  let plan
  try {
    const out = execFileSync(
      'npx',
      ['deepspace', 'agent', 'invoke', app, 'jams_preview', `--input-file=${file}`, '--json'],
      { encoding: 'utf8', timeout: 180_000 },
    )
    plan = findPlan(JSON.parse(out.trim().split('\n').pop()))
  } catch (err) {
    console.log(`FAIL  ${fx.name}: invoke error: ${String(err.stdout || err.message).slice(0, 300)}`)
    expectedTotal += fx.expect.length
    continue
  }
  if (!plan) {
    console.log(`FAIL  ${fx.name}: could not find a plan in the CLI output`)
    expectedTotal += fx.expect.length
    continue
  }

  const got = plan.creates
  const used = new Set()
  const misses = []
  for (const exp of fx.expect) {
    const idx = got.findIndex(
      (t, j) =>
        !used.has(j) &&
        exp.keywords.some((k) => t.title.toLowerCase().includes(k.toLowerCase())) &&
        (t.assignee || '') === exp.assignee,
    )
    if (idx === -1) misses.push(`${exp.keywords[0]} -> "${exp.assignee}"`)
    else used.add(idx)
  }
  const extra = got.filter((_, j) => !used.has(j))
  expectedTotal += fx.expect.length
  found += fx.expect.length - misses.length
  extras += extra.length

  const ok = misses.length === 0 && extra.length === 0
  if (ok) passed++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${fx.name}`)
  for (const t of got) console.log(`        got: "${t.title}" owner="${t.assignee}" basis=${t.basis}`)
  if (misses.length) console.log(`        missing: ${misses.join(', ')}`)
  if (extra.length) console.log(`        extra: ${extra.map((t) => t.title).join(', ')}`)
  if (plan.skipped?.length) console.log(`        filtered: ${plan.skipped.map((s) => s.reason).join('; ')}`)
}

console.log('')
console.log(`Fixtures passed: ${passed}/${fixtures.length}`)
console.log(`Expected tickets found: ${found}/${expectedTotal}`)
console.log(`Extra tickets: ${extras}`)
process.exit(passed === fixtures.length ? 0 : 1)
