window.__ModuleLoader__.load({
  id: 'dsh-plugin-linus-ssh',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })
    var React = require('react')
    var h = React.createElement

    var tagId = 'dsh-plugin-linus-ssh/style'
    if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css=' + JSON.stringify(tagId) + ']') === null) {
      var tag = document.createElement('style')
      tag.dataset.plugin = 'dsh-plugin-linus-ssh'
      tag.dataset.pluginCss = tagId
      tag.textContent = [
        '.lssh-root{display:flex;flex-direction:column;gap:12px;min-width:0;color:var(--dsw-alias-label-primary);}',
        '.lssh-card{border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);border-radius:12px;padding:12px;display:flex;flex-direction:column;gap:8px;}',
        '.lssh-kicker{font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:var(--dsw-alias-label-secondary);}',
        '.lssh-title{font-size:16px;font-weight:650;line-height:1.3;}',
        '.lssh-muted{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.5;white-space:pre-wrap;word-break:break-word;}',
        '.lssh-chip{appearance:none;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);border-radius:999px;padding:4px 10px;font-size:12px;max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
        '.lssh-code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;white-space:pre-wrap;}',
      ].join('')
      document.head.appendChild(tag)
    }

    function Panel() {
      return h('div', { className: 'lssh-root' },
        h('div', { className: 'lssh-card' },
          h('div', { className: 'lssh-kicker' }, 'Linus SSH'),
          h('div', { className: 'lssh-title' }, '常驻 OpenSSH 工具已启用'),
          h('div', { className: 'lssh-muted' }, '这个插件挂在桌面 profile 里，重启后还在。AI 会读 ~/.ssh/config，优先用本机密钥；没有密钥时可以用密码登录，改配置、跑命令。'),
        ),
        h('div', { className: 'lssh-card' },
          h('div', { className: 'lssh-kicker' }, '怎么用'),
          h('div', { className: 'lssh-muted lssh-code' }, [
            '直接说：连 154.44.9.128，看一下 nginx',
            '',
            '工具顺序：',
            'ssh_hosts  ->  ssh_use  ->  ssh_probe',
            '然后 ssh_exec / ssh_read / ssh_edit / ssh_write',
            '',
            '规则：优先密钥。密码用 ssh_add_host/ssh_use 的 password 传入。',
            '密码不会回显。改文件默认留 .bak.linus。',
            '当前主机和手动添加的机器写在 ~/.dsh/linus-ssh.json。',
          ].join('\n')),
        ),
      )
    }

    function Chip() {
      return h('button', {
        className: 'lssh-chip',
        type: 'button',
        title: 'Linus SSH is resident',
      }, 'SSH on')
    }

    var injectList = ['slots']

    function apply(ctx) {
      ctx.slots.inject('settings.section', function () {
        return ctx.slots.register(
          { name: 'settings.section', id: 'linus-ssh', order: 45, label: 'Linus SSH' },
          function () { return h(Panel) },
        )
      })
      ctx.slots.inject('conversation.input.left', function () {
        return ctx.slots.register(
          { name: 'conversation.input.left', id: 'linus-ssh-chip', order: 25, label: 'SSH' },
          function () { return h(Chip) },
        )
      })
    }

    exports.apply = apply
    exports.inject = injectList
    return module.exports
  },
})
