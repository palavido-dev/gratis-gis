#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# GratisGIS server bootstrap - Step 1: harden the box and install Docker.
# Idempotent; safe to re-run.
#
# Run as root on a fresh Ubuntu 24.04 LTS Hetzner cloud server.
#
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive

step() { printf '\n=== %s ===\n' "$*"; }

step "[1/9] Setting hostname and timezone"
hostnamectl set-hostname gratis-gis-prod
timedatectl set-timezone UTC

step "[2/9] Updating packages"
apt-get update
apt-get upgrade -y

step "[3/9] Installing baseline utilities"
apt-get install -y \
  ca-certificates curl gnupg lsb-release \
  ufw fail2ban unattended-upgrades \
  htop ncdu vim git jq tmux rsync

step "[4/9] Installing Docker engine + compose plugin"
if ! command -v docker >/dev/null 2>&1; then
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
    | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
  chmod a+r /etc/apt/keyrings/docker.gpg
  arch="$(dpkg --print-architecture)"
  codename="$(. /etc/os-release && echo "$VERSION_CODENAME")"
  echo "deb [arch=${arch} signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu ${codename} stable" \
    > /etc/apt/sources.list.d/docker.list
  apt-get update
fi
apt-get install -y docker-ce docker-ce-cli containerd.io \
  docker-buildx-plugin docker-compose-plugin
systemctl enable --now docker

step "[5/9] Configuring firewall (ufw)"
# Allow current ssh session through ufw before enabling (defensive).
ufw --force reset
ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp  comment 'SSH'
ufw allow 80/tcp  comment 'HTTP (Caddy ACME)'
ufw allow 443/tcp comment 'HTTPS'
ufw --force enable

step "[6/9] Configuring fail2ban for SSH"
cat > /etc/fail2ban/jail.local <<'EOF'
[DEFAULT]
bantime  = 1h
findtime = 10m
maxretry = 5

[sshd]
enabled = true
EOF
systemctl enable --now fail2ban
systemctl restart fail2ban

step "[7/9] Enabling unattended security upgrades"
# 20auto-upgrades enables the periodic timer. Default 50unattended-upgrades
# config already opts into security pocket.
cat > /etc/apt/apt.conf.d/20auto-upgrades <<'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
APT::Periodic::AutocleanInterval "7";
EOF

step "[8/9] Disabling SSH password auth (key-only from now on)"
mkdir -p /etc/ssh/sshd_config.d
cat > /etc/ssh/sshd_config.d/99-gratis-gis.conf <<'EOF'
# Layered on top of the distro defaults. Key-only access; root may log in
# with a key but never with a password.
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin prohibit-password
EOF
# Validate config before reloading so a typo can never lock us out.
sshd -t
systemctl reload ssh

step "[9/9] Verifying"
echo "--- Docker ---"
docker --version
docker compose version
echo "--- ufw ---"
ufw status verbose
echo "--- fail2ban ---"
systemctl is-active fail2ban
echo "--- time ---"
timedatectl | head -5
echo
echo "=== Step 1 complete ==="
echo "BEFORE closing your existing SSH session: open a NEW terminal and run"
echo "  ssh root@62.238.20.183"
echo "to confirm key-only auth still works. If that succeeds you're safe."
