import os from 'node:os'
import path from 'node:path'
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { defineTool } from '@deepseek-ai/dsh-tools'

const name = 'linus-ssh'
const inject = ['tools', 'subprocess']

const MAX_TEXT = 400000
const STATE_FILE = path.join(os.homedir(), '.dsh', 'linus-ssh.json')
const ASKPASS_FILE = path.join(os.homedir(), '.dsh', 'linus-ssh-askpass.cmd')
const ASKPASS_SCRIPT = [
  '@echo off',
  'if exist "%LINUS_SSH_ASKPASS_FILE%" type "%LINUS_SSH_ASKPASS_FILE%"',
].join('\r\n') + '\r\n'

function trim(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function asPort(value) {
  const port = Number(value)
  if (!Number.isFinite(port) || port <= 0 || port > 65535) return 22
  return Math.floor(port)
}

function slug(value) {
  const raw = trim(value).toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '')
  return raw.length > 0 ? raw : 'host'
}

function renderValue(_args, value) {
  if (value && typeof value.text === 'string') return [{ type: 'text', text: value.text }]
  return [{ type: 'text', text: 'ok' }]
}

function fail(message, extra) {
  return Object.assign({ ok: false, error: message, text: message }, extra || {})
}

function ok(text, extra) {
  return Object.assign({ ok: true, text }, extra || {})
}

function clip(text) {
  const value = String(text || '')
  if (value.length <= MAX_TEXT) return value
  return value.slice(0, MAX_TEXT) + '\n[truncated to ' + MAX_TEXT + ' chars]'
}

function shQuote(value) {
  return "'" + String(value).replace(/'/g, "'\\''") + "'"
}

function readCollected(reader) {
  if (!reader || typeof reader.readFrom !== 'function') return ''
  const chunk = reader.readFrom(0)
  if (!chunk) return ''
  const text = typeof chunk.text === 'string' ? chunk.text : ''
  if (chunk.lossy) {
    const spill = typeof chunk.spillPath === 'string' ? chunk.spillPath : '(unavailable)'
    return text + '\n[truncated; full output: ' + spill + ']'
  }
  return text
}

function formatRun(result) {
  let body = result.stdout || ''
  if (result.stderr) {
    if (body && !body.endsWith('\n')) body += '\n'
    body += '[stderr]\n' + result.stderr
  }
  if (!body) body = '(no output)'
  const marks = []
  if (result.timedOut) marks.push('[timed out]')
  if (result.signal) marks.push('[killed by signal: ' + result.signal + ']')
  else if (result.exitCode !== 0 && result.exitCode !== null) marks.push('[exit code: ' + result.exitCode + ']')
  if (marks.length === 0) return body
  if (!body.endsWith('\n')) body += '\n'
  return body + marks.join('\n')
}

function apply(ctx) {
  const hosts = []
  const extraKeys = []
  const secrets = {}
  let currentId = ''
  let lastProbe = null
  let sshExe = ''
  const homeDir = os.homedir()
  const sshDir = path.join(homeDir, '.ssh')
  const localCwd = homeDir || process.cwd()
  const secretDir = path.join(homeDir, '.dsh', 'linus-ssh-secrets')

  function uniqueId(base) {
    let id = slug(base)
    let n = 2
    while (hosts.some((host) => host.id === id)) {
      id = slug(base) + '-' + n
      n += 1
    }
    return id
  }

  function hostTarget(host) {
    const name = host.host || host.alias
    if (host.user) return host.user + '@' + name
    return name
  }

  function publicHost(host) {
    return {
      id: host.id,
      label: host.label,
      alias: host.alias,
      host: host.host,
      user: host.user,
      port: host.port,
      identityFile: host.identityFile,
      source: host.source,
      hasPassword: Boolean(secrets[host.id]),
      target: hostTarget(host),
    }
  }

  function rememberPassword(host, password) {
    const value = trim(password)
    if (value) secrets[host.id] = value
    return Boolean(secrets[host.id])
  }

  async function writeAskpass() {
    await mkdir(path.dirname(ASKPASS_FILE), { recursive: true })
    await writeFile(ASKPASS_FILE, ASKPASS_SCRIPT, 'utf8')
  }

  function findHost(idOrTarget) {
    const key = trim(idOrTarget)
    if (!key) return undefined
    return hosts.find((host) => (
      host.id === key
      || host.alias === key
      || host.host === key
      || hostTarget(host) === key
    ))
  }

  function currentHost() {
    if (!currentId) return undefined
    return findHost(currentId)
  }

  function snapshot() {
    const current = currentHost()
    return {
      currentId: current ? current.id : '',
      current: current ? publicHost(current) : null,
      hosts: hosts.map(publicHost),
      extraKeys: extraKeys.slice(),
      lastProbe,
    }
  }

  async function persist() {
    const payload = {
      currentId,
      hosts: hosts.filter((host) => host.source === 'manual').map((host) => ({
        id: host.id,
        label: host.label,
        alias: host.alias,
        host: host.host,
        user: host.user,
        port: host.port,
        identityFile: host.identityFile,
        source: 'manual',
        ...secrets[host.id] ? { password: secrets[host.id] } : {},
      })),
    }
    try {
      await mkdir(path.dirname(STATE_FILE), { recursive: true })
      await writeFile(STATE_FILE, JSON.stringify(payload, null, 2), 'utf8')
    } catch (_error) {}
  }

  async function restoreManual() {
    try {
      const raw = await readFile(STATE_FILE, 'utf8')
      const data = JSON.parse(raw)
      if (data && Array.isArray(data.hosts)) {
        for (const item of data.hosts) {
          if (!item || !trim(item.host || item.alias)) continue
          if (findHost(item.id) || findHost(item.alias) || findHost(item.host)) continue
          hosts.push({
            id: trim(item.id) || uniqueId(item.alias || item.host),
            label: trim(item.label) || trim(item.alias) || trim(item.host),
            alias: trim(item.alias) || trim(item.host),
            host: trim(item.host) || trim(item.alias),
            user: trim(item.user),
            port: asPort(item.port),
            identityFile: trim(item.identityFile),
            source: 'manual',
          })
          if (trim(item.password)) secrets[hosts[hosts.length - 1].id] = trim(item.password)
        }
      }
      if (data && trim(data.currentId) && findHost(data.currentId)) currentId = trim(data.currentId)
    } catch (_error) {}
  }

  function expandHome(filePath) {
    const value = trim(filePath)
    if (!value) return ''
    if (value.charAt(0) === '~') return path.join(homeDir, value.slice(1).replace(/^[\\/]/, ''))
    return value
  }

  function parseSshConfig(text) {
    const blocks = []
    let current = null
    const lines = String(text || '').split(/\r?\n/)
    for (const raw of lines) {
      const line = raw.replace(/#.*$/, '').trim()
      if (!line) continue
      const parts = line.split(/\s+/)
      const key = String(parts[0] || '').toLowerCase()
      const value = parts.slice(1).join(' ').trim()
      if (key === 'host') {
        current = {
          aliases: value.split(/\s+/).filter(Boolean),
          host: '',
          user: '',
          port: 22,
          identityFile: '',
        }
        blocks.push(current)
        continue
      }
      if (!current) continue
      if (key === 'hostname') current.host = value
      else if (key === 'user') current.user = value
      else if (key === 'port') current.port = asPort(value)
      else if (key === 'identityfile' && !current.identityFile) current.identityFile = value
    }
    const byAlias = {}
    for (const block of blocks) {
      const aliases = block.aliases.filter((item) => (
        item
        && item !== '*'
        && item.indexOf('*') === -1
        && item.charAt(0) !== '!'
      ))
      for (const alias of aliases) {
        byAlias[alias] = {
          alias,
          host: block.host || alias,
          user: block.user,
          port: block.port || 22,
          identityFile: block.identityFile,
        }
      }
    }
    return Object.keys(byAlias).map((alias) => {
      const item = byAlias[alias]
      return {
        id: uniqueId(alias),
        label: alias,
        alias,
        host: item.host,
        user: item.user,
        port: item.port,
        identityFile: item.identityFile,
        source: 'ssh-config',
      }
    })
  }

  function upsertHost(input) {
    const hostName = trim(input.host || input.alias)
    const alias = trim(input.alias) || hostName
    if (!hostName) throw new Error('host is required')
    const existing = findHost(trim(input.id) || alias) || findHost(hostName)
    if (existing) {
      existing.label = trim(input.label) || existing.label || alias
      existing.alias = alias
      existing.host = hostName
      if (trim(input.user)) existing.user = trim(input.user)
      if (input.port !== undefined) existing.port = asPort(input.port)
      if (trim(input.identityFile)) existing.identityFile = trim(input.identityFile)
      if (input.forceManual) existing.source = 'manual'
      return existing
    }
    const created = {
      id: uniqueId(alias),
      label: trim(input.label) || alias,
      alias,
      host: hostName,
      user: trim(input.user),
      port: asPort(input.port),
      identityFile: trim(input.identityFile),
      source: input.forceManual ? 'manual' : 'ssh-config',
    }
    hosts.push(created)
    return created
  }

  async function refreshLocalSsh() {
    if (!sshExe) {
      try {
        sshExe = await ctx.subprocess.resolveExecutable('ssh')
      } catch (_error) {
        sshExe = 'ssh'
      }
    }
    extraKeys.length = 0
    const kept = hosts.filter((host) => host.source !== 'ssh-config')
    hosts.length = 0
    const fs = ctx.get('fs')
    if (fs !== undefined) {
      try {
        const dirTarget = await fs.resolve(sshDir)
        const entries = await fs.listDir(dirTarget)
        for (const entry of entries) {
          const fileName = entry && entry.name
          if (typeof fileName !== 'string') continue
          if (entry.type === 'directory') continue
          if (fileName === 'config' || fileName === 'known_hosts' || fileName === 'known_hosts.old' || fileName === 'authorized_keys' || fileName === 'config.bak') continue
          if (fileName.slice(-4) === '.pub' || fileName.slice(-4) === '.old') continue
          const looksLikeKey = fileName.indexOf('id_') === 0 || fileName.indexOf('_rsa') !== -1 || fileName.indexOf('_ed25519') !== -1 || fileName.indexOf('_ecdsa') !== -1
          if (!looksLikeKey) continue
          extraKeys.push(path.join(sshDir, fileName))
        }
      } catch (_error) {}
      try {
        const cfgTarget = await fs.resolve(path.join(sshDir, 'config'))
        const text = await fs.readText(cfgTarget)
        for (const host of parseSshConfig(text)) hosts.push(host)
      } catch (_error) {}
    } else {
      try {
        const text = await readFile(path.join(sshDir, 'config'), 'utf8')
        for (const host of parseSshConfig(text)) hosts.push(host)
      } catch (_error) {}
    }
    for (const host of kept) {
      if (!findHost(host.id) && !findHost(host.alias) && !findHost(host.host)) hosts.push(host)
    }
    if (currentId && !findHost(currentId)) currentId = ''
    return snapshot()
  }

  function buildSshArgv(host, remoteCommand) {
    const argv = [sshExe || 'ssh']
    const password = secrets[host.id]
    argv.push('-o', 'ConnectTimeout=12', '-o', 'StrictHostKeyChecking=accept-new')
    if (password) {
      argv.push(
        '-o', 'PreferredAuthentications=password,keyboard-interactive,publickey',
        '-o', 'PubkeyAuthentication=no',
        '-o', 'NumberOfPasswordPrompts=1',
        '-o', 'BatchMode=no',
      )
    } else {
      argv.push(
        '-o', 'BatchMode=yes',
        '-o', 'PreferredAuthentications=publickey',
        '-o', 'NumberOfPasswordPrompts=0',
      )
    }
    if (host.port && host.port !== 22) argv.push('-p', String(host.port))
    const identity = expandHome(host.identityFile)
    if (!password && identity) {
      argv.push('-i', identity, '-o', 'IdentitiesOnly=yes')
    } else if (!password) {
      for (let i = 0; i < extraKeys.length && i < 4; i++) argv.push('-i', extraKeys[i])
    }
    argv.push(hostTarget(host))
    if (remoteCommand !== undefined) argv.push(remoteCommand)
    return argv
  }

  function requireCurrent(args) {
    const requested = trim(args && (args.host || args.target))
    if (requested) {
      const found = findHost(requested)
      const at = requested.indexOf('@')
      const host = found || upsertHost({
        alias: requested,
        host: at >= 0 ? requested.slice(at + 1) : requested,
        user: at >= 0 ? requested.slice(0, at) : '',
        port: args && args.port,
        identityFile: args && args.identity_file,
        forceManual: true,
      })
      if (args && args.password) rememberPassword(host, args.password)
      return host
    }
    const current = currentHost()
    if (!current) throw new Error('No current host. Call ssh_use first or pass host=user@ip.')
    return current
  }

  async function runArgv(argv, options) {
    const opts = options || {}
    const handle = ctx.subprocess.spawn({
      argv,
      cwd: localCwd,
      stdio: {
        stdin: opts.stdin !== undefined ? { data: String(opts.stdin) } : 'ignore',
        stdout: { maxBytes: MAX_TEXT, spill: { maxBytes: MAX_TEXT * 4 } },
        stderr: { maxBytes: 200000, spill: { maxBytes: MAX_TEXT } },
      },
      graceMs: 3000,
      signal: opts.signal,
      ...opts.env ? { env: opts.env } : {},
    })
    const outcome = await handle.done
    return {
      exitCode: outcome.exitCode,
      signal: outcome.signal,
      timedOut: false,
      aborted: Boolean(opts.signal && opts.signal.aborted),
      stdout: readCollected(handle.collected && handle.collected.stdout),
      stderr: readCollected(handle.collected && handle.collected.stderr),
    }
  }

  async function sshRun(host, remoteCommand, options) {
    const opts = options || {}
    const password = secrets[host.id]
    if (!password) return runArgv(buildSshArgv(host, remoteCommand), opts)
    await mkdir(secretDir, { recursive: true })
    await writeAskpass()
    const passFile = path.join(secretDir, host.id + '.pass')
    await writeFile(passFile, password, 'utf8')
    try {
      return await runArgv(buildSshArgv(host, remoteCommand), Object.assign({}, opts, {
        env: {
          DISPLAY: process.env.DISPLAY || 'dummy:0',
          SSH_ASKPASS: ASKPASS_FILE,
          SSH_ASKPASS_REQUIRE: 'force',
          LINUS_SSH_ASKPASS_FILE: passFile,
        },
      }))
    } finally {
      try { await unlink(passFile) } catch (_error) {}
    }
  }

  function register(definition) {
    ctx.tools.register(defineTool(definition))
  }

  register({
    name: 'ssh_hosts',
    description: 'List SSH hosts from ~/.ssh/config plus hosts added in this session. Call this before ssh_use.',
    parameters: {},
    output: { schema: { type: 'json' }, render: renderValue },
    async execute() {
      const state = await refreshLocalSsh()
      const lines = state.hosts.length === 0
        ? ['No hosts yet. Add one with ssh_use or ssh_add_host.']
        : state.hosts.map((host) => {
          const mark = state.currentId === host.id ? '* ' : '  '
          return mark + host.id + '  ' + host.target + (host.port !== 22 ? ':' + host.port : '') + '  [' + host.source + ']' + (host.hasPassword ? ' password=set' : '')
        })
      if (state.extraKeys.length > 0) {
        lines.push('', 'keys:')
        for (const key of state.extraKeys) lines.push('  ' + key)
      }
      if (state.current) lines.push('', 'current: ' + state.current.target)
      return ok(lines.join('\n'), { current: state.current, hosts: state.hosts, extraKeys: state.extraKeys })
    },
  })

  register({
    name: 'ssh_add_host',
    description: 'Remember a server. Prefer a key. A password is stored locally and used via SSH_ASKPASS; it is never echoed back.',
    parameters: {
      host: { type: 'string', required: true, description: 'IP, hostname, or existing ~/.ssh/config Host alias.' },
      user: { type: 'string', description: 'SSH user, e.g. root or ubuntu.' },
      port: { type: 'number', description: 'SSH port. Default 22.' },
      alias: { type: 'string', description: 'Short name to reuse later.' },
      identity_file: { type: 'string', description: 'Private key path. Optional if a default key works.' },
      password: { type: 'string', description: 'Optional login password. Stored locally, never printed back.' },
      make_current: { type: 'boolean', description: 'If true, also select this host. Default true.' },
    },
    output: { schema: { type: 'json' }, render: renderValue },
    async execute(args) {
      await refreshLocalSsh()
      const host = upsertHost({
        alias: args.alias,
        host: args.host,
        user: args.user,
        port: args.port,
        identityFile: args.identity_file,
        forceManual: true,
      })
      if (args.password) rememberPassword(host, args.password)
      if (args.make_current !== false) currentId = host.id
      await persist()
      return ok('saved ' + hostTarget(host) + (currentId === host.id ? ' (current)' : '') + (secrets[host.id] ? ' password=set' : ''), { host: publicHost(host) })
    },
  })

  register({
    name: 'ssh_use',
    description: 'Select the current SSH target. Later ssh_exec/ssh_read/ssh_write/ssh_edit use this unless host is overridden.',
    parameters: {
      host: { type: 'string', required: true, description: 'Host id, alias, IP, or user@host from ssh_hosts.' },
      user: { type: 'string', description: 'Override user when host is a bare IP.' },
      port: { type: 'number', description: 'Override port.' },
      identity_file: { type: 'string', description: 'Override private key path.' },
      password: { type: 'string', description: 'Optional login password. Stored locally, never printed back.' },
    },
    output: { schema: { type: 'json' }, render: renderValue },
    async execute(args) {
      await refreshLocalSsh()
      const host = requireCurrent(args)
      if (trim(args.user)) host.user = trim(args.user)
      if (args.port !== undefined) host.port = asPort(args.port)
      if (trim(args.identity_file)) host.identityFile = trim(args.identity_file)
      if (args.password) rememberPassword(host, args.password)
      currentId = host.id
      lastProbe = null
      await persist()
      return ok('current host = ' + hostTarget(host) + (secrets[host.id] ? ' password=set' : ''), { host: publicHost(host) })
    },
  })

  register({
    name: 'ssh_probe',
    description: 'Check connectivity and print a short machine fact sheet: user, host, os, cwd.',
    parameters: {
      host: { type: 'string', description: 'Optional host override. Defaults to current.' },
    },
    output: { schema: { type: 'json' }, render: renderValue },
    async execute(args, exec) {
      await refreshLocalSsh()
      const host = requireCurrent(args)
      currentId = host.id
      await persist()
      const script = [
        'printf "user=%s\\n" "$(id -un 2>/dev/null)"',
        'printf "uid=%s\\n" "$(id -u 2>/dev/null)"',
        'printf "hostname=%s\\n" "$(hostname 2>/dev/null)"',
        'printf "cwd=%s\\n" "$(pwd)"',
        'printf "uname=%s\\n" "$(uname -a 2>/dev/null)"',
        'if [ -f /etc/os-release ]; then . /etc/os-release; printf "os=%s\\n" "$PRETTY_NAME"; fi',
        'df -hP / 2>/dev/null | sed -n "2p"',
        'if command -v sudo >/dev/null 2>&1 && sudo -n true 2>/dev/null; then echo sudo=nopasswd; else echo sudo=auth; fi',
      ].join('; ')
      const result = await sshRun(host, script, { signal: exec && exec.signal })
      lastProbe = {
        target: hostTarget(host),
        ok: result.exitCode === 0,
        at: Date.now(),
        summary: clip(formatRun(result)),
      }
      if (result.exitCode !== 0) {
        return fail('probe failed for ' + hostTarget(host) + '\n' + lastProbe.summary, {
          host: publicHost(host),
          probe: lastProbe,
        })
      }
      return ok('probe ' + hostTarget(host) + '\n' + lastProbe.summary, {
        host: publicHost(host),
        probe: lastProbe,
      })
    },
  })

  register({
    name: 'ssh_exec',
    description: 'Run one non-interactive command on the current server. Fresh shell each call. Use workdir instead of relying on cd across calls.',
    parameters: {
      command: { type: 'string', required: true, description: 'Remote shell command.' },
      host: { type: 'string', description: 'Optional host override.' },
      workdir: { type: 'string', description: 'Remote working directory.' },
      timeout_ms: { type: 'number', description: 'Timeout in milliseconds. Default 45000. Currently advisory.' },
      sudo: { type: 'boolean', description: 'Prefix the command with sudo -n.' },
    },
    output: { schema: { type: 'json' }, render: renderValue },
    presentCall(args) {
      return { card: 'terminal', title: args.command, description: trim(args.host) || 'ssh' }
    },
    async execute(args, exec) {
      const command = trim(args.command)
      if (!command) return fail('command is empty')
      await refreshLocalSsh()
      const host = requireCurrent(args)
      currentId = host.id
      await persist()
      const workdir = trim(args.workdir)
      let remote = command
      if (args.sudo === true) remote = 'sudo -n -- ' + remote
      if (workdir) remote = 'cd ' + shQuote(workdir) + ' && ' + remote
      const result = await sshRun(host, remote, { signal: exec && exec.signal })
      return {
        ok: result.exitCode === 0,
        exitCode: result.exitCode,
        host: publicHost(host),
        text: formatRun(result),
      }
    },
  })

  register({
    name: 'ssh_ls',
    description: 'List a remote directory.',
    parameters: {
      path: { type: 'string', description: 'Remote directory. Default .' },
      host: { type: 'string', description: 'Optional host override.' },
    },
    output: { schema: { type: 'json' }, render: renderValue },
    async execute(args, exec) {
      await refreshLocalSsh()
      const host = requireCurrent(args)
      currentId = host.id
      const remotePath = trim(args.path) || '.'
      const result = await sshRun(host, 'ls -la -- ' + shQuote(remotePath), { signal: exec && exec.signal })
      return {
        ok: result.exitCode === 0,
        exitCode: result.exitCode,
        host: publicHost(host),
        path: remotePath,
        text: formatRun(result),
      }
    },
  })

  register({
    name: 'ssh_read',
    description: 'Read a remote UTF-8 text file so you can inspect or edit configuration.',
    parameters: {
      path: { type: 'string', required: true, description: 'Absolute or home-relative remote file path.' },
      host: { type: 'string', description: 'Optional host override.' },
      offset: { type: 'number', description: '1-based start line. Default 1.' },
      limit: { type: 'number', description: 'Max lines to return. Default 2000.' },
    },
    output: { schema: { type: 'json' }, render: renderValue },
    async execute(args, exec) {
      const remotePath = trim(args.path)
      if (!remotePath) return fail('path is required')
      await refreshLocalSsh()
      const host = requireCurrent(args)
      currentId = host.id
      const offset = Number(args.offset) > 0 ? Math.floor(Number(args.offset)) : 1
      const limit = Number(args.limit) > 0 ? Math.floor(Number(args.limit)) : 2000
      const end = offset + limit - 1
      const script = [
        'path=' + shQuote(remotePath),
        'if [ ! -e "$path" ]; then echo missing; exit 2; fi',
        'if [ -d "$path" ]; then echo directory; exit 3; fi',
        'if [ ! -r "$path" ]; then echo unreadable; exit 4; fi',
        'wc -l < "$path"',
        'wc -c < "$path"',
        'sed -n ' + shQuote(String(offset) + ',' + String(end) + 'p') + ' -- "$path"',
      ].join('\n')
      const result = await sshRun(host, script, { signal: exec && exec.signal })
      if (result.exitCode !== 0) {
        return fail('read failed: ' + remotePath + '\n' + formatRun(result), { path: remotePath, host: publicHost(host) })
      }
      const lines = result.stdout.split(/\n/)
      const totalLines = Number(trim(lines[0])) || 0
      const bytes = Number(trim(lines[1])) || 0
      const content = lines.slice(2).join('\n')
      const numbered = content.split(/\n/).map((line, index) => {
        const n = String(offset + index)
        return n.padStart(6, ' ') + '| ' + line
      }).join('\n')
      return ok(remotePath + '  ' + bytes + ' bytes  ' + totalLines + ' lines\n' + clip(numbered), {
        path: remotePath,
        bytes,
        totalLines,
        offset,
        content: clip(content),
        host: publicHost(host),
      })
    },
  })

  register({
    name: 'ssh_write',
    description: 'Create or replace a remote UTF-8 text file. Makes parent directories. Writes path.bak.linus first when the file exists.',
    parameters: {
      path: { type: 'string', required: true, description: 'Remote file path to write.' },
      content: { type: 'string', required: true, description: 'Full new file content.' },
      host: { type: 'string', description: 'Optional host override.' },
      sudo: { type: 'boolean', description: 'Write with sudo tee. Use for /etc and other root files.' },
      backup: { type: 'boolean', description: 'Backup existing file to path.bak.linus. Default true.' },
      mode: { type: 'string', description: 'Optional chmod mode such as 644 or 600.' },
    },
    output: { schema: { type: 'json' }, render: renderValue },
    async execute(args, exec) {
      const remotePath = trim(args.path)
      if (!remotePath) return fail('path is required')
      if (typeof args.content !== 'string') return fail('content is required')
      if (args.content.length > MAX_TEXT) return fail('content too large; keep it under ' + MAX_TEXT + ' chars')
      await refreshLocalSsh()
      const host = requireCurrent(args)
      currentId = host.id
      const sudo = args.sudo === true
      const backup = args.backup !== false
      const mode = trim(args.mode)
      const prefix = sudo ? 'sudo ' : ''
      const script = [
        'set -e',
        'path=' + shQuote(remotePath),
        prefix + 'mkdir -p -- "$(dirname -- "$path")"',
        backup ? 'if [ -f "$path" ]; then ' + prefix + 'cp -a -- "$path" "$path.bak.linus"; fi' : 'true',
        prefix + 'tee -- "$path" >/dev/null',
        mode ? prefix + 'chmod ' + shQuote(mode) + ' -- "$path"' : 'true',
        'wc -c < "$path"',
      ].join('\n')
      const result = await sshRun(host, script, { stdin: args.content, signal: exec && exec.signal })
      if (result.exitCode !== 0) {
        return fail('write failed: ' + remotePath + '\n' + formatRun(result), { path: remotePath, host: publicHost(host) })
      }
      return ok('wrote ' + remotePath + (sudo ? ' (sudo)' : '') + (backup ? ' backup=.bak.linus' : ''), {
        path: remotePath,
        bytes: Number(trim(result.stdout)) || args.content.length,
        host: publicHost(host),
      })
    },
  })

  register({
    name: 'ssh_edit',
    description: 'Surgical remote text edit. Replaces exact old_string with new_string. Fails if the match is missing or not unique unless replace_all is true.',
    parameters: {
      path: { type: 'string', required: true, description: 'Remote file path to edit.' },
      old_string: { type: 'string', required: true, description: 'Exact text to find.' },
      new_string: { type: 'string', required: true, description: 'Replacement text. Empty deletes the match.' },
      replace_all: { type: 'boolean', description: 'Replace every match. Default false.' },
      host: { type: 'string', description: 'Optional host override.' },
      sudo: { type: 'boolean', description: 'Write back with sudo tee.' },
      backup: { type: 'boolean', description: 'Backup to path.bak.linus. Default true.' },
    },
    output: { schema: { type: 'json' }, render: renderValue },
    async execute(args, exec) {
      const remotePath = trim(args.path)
      if (!remotePath) return fail('path is required')
      if (typeof args.old_string !== 'string' || args.old_string.length === 0) return fail('old_string is required')
      if (typeof args.new_string !== 'string') return fail('new_string is required')
      await refreshLocalSsh()
      const host = requireCurrent(args)
      currentId = host.id
      const read = await sshRun(host, 'if [ ! -f ' + shQuote(remotePath) + ' ]; then echo missing; exit 2; fi; cat -- ' + shQuote(remotePath), {
        signal: exec && exec.signal,
      })
      if (read.exitCode !== 0) {
        return fail('edit read failed: ' + remotePath + '\n' + formatRun(read), { path: remotePath, host: publicHost(host) })
      }
      const content = read.stdout
      const parts = content.split(args.old_string)
      const count = parts.length - 1
      if (count === 0) return fail('old_string not found in ' + remotePath)
      if (count > 1 && args.replace_all !== true) {
        return fail('old_string matched ' + count + ' times in ' + remotePath + '; pass replace_all=true or give a unique snippet')
      }
      const next = args.replace_all === true
        ? parts.join(args.new_string)
        : parts[0] + args.new_string + parts.slice(1).join(args.old_string)
      if (next === content) return fail('edit made no change')
      const sudo = args.sudo === true
      const backup = args.backup !== false
      const prefix = sudo ? 'sudo ' : ''
      const script = [
        'set -e',
        'path=' + shQuote(remotePath),
        backup ? 'if [ -f "$path" ]; then ' + prefix + 'cp -a -- "$path" "$path.bak.linus"; fi' : 'true',
        prefix + 'tee -- "$path" >/dev/null',
      ].join('\n')
      const write = await sshRun(host, script, { stdin: next, signal: exec && exec.signal })
      if (write.exitCode !== 0) {
        return fail('edit write failed: ' + remotePath + '\n' + formatRun(write), { path: remotePath, host: publicHost(host) })
      }
      return ok('edited ' + remotePath + ' (' + count + ' replacement' + (count === 1 ? '' : 's') + ')', {
        path: remotePath,
        replacements: args.replace_all === true ? count : 1,
        host: publicHost(host),
      })
    },
  })

  const systemPrompt = ctx.get('systemPrompt')
  if (systemPrompt !== undefined) {
    systemPrompt.section({
      name: 'linus-ssh',
      order: 118,
      text: [
        'Linus SSH is loaded. You can operate remote Linux servers through the local OpenSSH client.',
        'Workflow: ssh_hosts -> ssh_use -> ssh_probe -> then ssh_exec / ssh_read / ssh_edit / ssh_write.',
        'Rules:',
        '- One current host. Do not guess IPs when ssh_hosts already listed them; ask only if several targets fit.',
        '- Read a config before writing it. Prefer ssh_edit over rewriting a whole file.',
        '- ssh_write/ssh_edit make path.bak.linus unless backup=false. Use sudo=true for /etc and other root files.',
        '- Prefer a key. Password login is allowed: pass password=... to ssh_add_host or ssh_use. Never echo the password, token, or private key back.',
        '- Non-interactive commands only. No pagers, no vim, no ssh -t.',
        '- After a change, verify with a small command. Say what broke if a command fails; do not retry blindly.',
        '- This is a real machine. No drive-by reboots, no rm -rf /, no package spam unless the user asked.',
      ].join('\n'),
    })
  }

  void restoreManual().then(() => refreshLocalSsh()).catch(() => {})
}

export { apply, inject, name }
