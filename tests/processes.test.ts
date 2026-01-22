import { once } from 'node:events'
import { afterEach, describe, expect, it } from 'vitest'

import type { ProcessRegistration } from '../packages/core/src/processes.js'
import {
  execFileTracked,
  runWithProcessContext,
  setProcessObserver,
  spawnTracked,
} from '../packages/core/src/processes.js'

const createObserver = (capture: {
  registrations: ProcessRegistration[]
  outputs: Array<{ stream: 'stdout' | 'stderr'; line: string }>
}) => ({
  register: (info: ProcessRegistration) => {
    capture.registrations.push(info)
    return {
      id: info.command,
      setPid: () => {},
      appendOutput: (stream, line) => capture.outputs.push({ stream, line }),
      setProgress: () => {},
      setStatus: () => {},
      finish: () => {},
    }
  },
})

afterEach(() => {
  setProcessObserver(null)
})

describe('process tracking', () => {
  it('propagates process context to registrations', async () => {
    const capture = { registrations: [] as ProcessRegistration[], outputs: [] }
    setProcessObserver(createObserver(capture))

    await runWithProcessContext({ runId: 'run-123', source: 'test' }, async () => {
      const { proc } = spawnTracked(process.execPath, ['-e', 'process.exit(0)'], {
        stdio: 'ignore',
        captureOutput: false,
      })
      await once(proc, 'close')
    })

    expect(capture.registrations.length).toBe(1)
    expect(capture.registrations[0].runId).toBe('run-123')
    expect(capture.registrations[0].source).toBe('test')
  })

  it('captures execFile output', async () => {
    const capture = {
      registrations: [] as ProcessRegistration[],
      outputs: [] as Array<{ stream: 'stdout' | 'stderr'; line: string }>,
    }
    setProcessObserver(createObserver(capture))

    const proc = execFileTracked(process.execPath, ['-e', 'console.log("hello")'])
    await once(proc, 'close')

    expect(capture.registrations.length).toBe(1)
    expect(capture.outputs.some((line) => line.line.includes('hello'))).toBe(true)
  })

  it('supports execFile callback signatures', async () => {
    const capture = {
      registrations: [] as ProcessRegistration[],
      outputs: [] as Array<{ stream: 'stdout' | 'stderr'; line: string }>,
    }
    setProcessObserver(createObserver(capture))

    await new Promise<void>((resolve, reject) => {
      const proc = execFileTracked(
        process.execPath,
        ['-e', 'console.log("callback")'],
        (error, stdout) => {
          if (error) {
            reject(error)
            return
          }
          expect(stdout.toString()).toContain('callback')
          resolve()
        }
      )
      proc.on('error', reject)
    })

    if (process.platform !== 'win32') {
      await new Promise<void>((resolve, reject) => {
        const proc = execFileTracked('/usr/bin/true', (error) => {
          if (error) {
            reject(error)
            return
          }
          resolve()
        })
        proc.on('error', reject)
      })
    }

    expect(capture.registrations.length).toBeGreaterThanOrEqual(2)
  })
})
