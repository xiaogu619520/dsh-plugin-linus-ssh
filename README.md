# dsh-plugin-linus-ssh

常驻 OpenSSH 插件。挂在 DSH Desktop 的 desktop profile 里，重启后还在。AI 用本机 `ssh` 连 Linux 机器、读改配置。优先密钥，也可以把 `password` 传给 `ssh_add_host` / `ssh_use`。

## AI 一键安装

在任意 DeepSeek Harness 会话中，把下面这句话发给 AI：

```text
帮我安装并启用这个 DSH 插件：https://github.com/xiaogu619520/dsh-plugin-linus-ssh.git
```

## 手动安装

1. 克隆到桌面 Profile 目录：

```bash
cd ~/.dsh/profiles/desktop/plugins
git clone https://github.com/xiaogu619520/dsh-plugin-linus-ssh.git
```

2. 在 `~/.dsh/profiles/desktop/package.json` 里声明依赖：

```json
{
  "dependencies": {
    "dsh-plugin-linus-ssh": "file:./plugins/dsh-plugin-linus-ssh"
  }
}
```

3. 在 `~/.dsh/profiles/desktop/cordis.patch.yml` 里挂载：

```yaml
- insert:
    - id: linus-ssh
      name: dsh-plugin-linus-ssh
```

4. 重启 DeepSeek Harness / DSH Desktop。

## 工具

`ssh_hosts` `ssh_add_host` `ssh_use` `ssh_probe` `ssh_exec` `ssh_ls` `ssh_read` `ssh_edit` `ssh_write`

当前主机和手动添加的机器保存在 `~/.dsh/linus-ssh.json`。这个文件可能含密码，不要提交到 Git。

## 规则

- 优先用本机密钥（`~/.ssh` / `ssh_use` 的 `identityFile`）
- 密码只通过 `ssh_add_host` / `ssh_use` 的 `password` 传入，不会回显
- 改远程文件默认留 `.bak.linus`

## 完整套装

如果想一次装上本机全部插件和模型配置模板，用：

https://github.com/xiaogu619520/dsh-desktop-setup
