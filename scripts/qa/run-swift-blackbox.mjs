#!/usr/bin/env node

import { runSwiftBlackbox } from '../../qa/drivers/swift-blackbox/driver.mjs'

try {
  process.exitCode = await runSwiftBlackbox()
} catch (error) {
  process.stderr.write(`Swift black-box QA failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
  process.exitCode = 1
}
