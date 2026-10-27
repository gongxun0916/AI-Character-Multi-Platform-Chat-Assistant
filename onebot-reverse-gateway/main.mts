import { readFileSync } from 'node:fs'
import { configFrom, createGateway } from './gateway.mts'

try {
  const path = process.argv[2]
  if (!path) throw new Error('usage: node main.mts /absolute/path/config.json')
  const config = configFrom(JSON.parse(readFileSync(path, 'utf8')))
  const gateway = await createGateway(config)
  process.stdout.write(`gateway_listening ${config.host}:${config.port}${config.path}\n`)
  if (gateway.store.state.blocked) process.stderr.write('gateway_blocked_manual_review_required\n')
  let stopping = false
  const stop = () => {
    if (stopping) return
    stopping = true
    void gateway.close().then(() => { process.exitCode = 0 }, () => { process.exitCode = 1 })
  }
  process.on('SIGTERM', stop)
  process.on('SIGINT', stop)
} catch {
  process.stderr.write('gateway_start_failed_check_config_secrets_state_and_lock\n')
  process.exitCode = 1
}
