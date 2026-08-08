#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# Fence the script network off from the host and from link-local (#221).
#
# Docker gives the executor container its own network, and that stops it
# reaching postgres, minio, and keycloak. It does NOT stop it reaching
# two other things, both measured on prod rather than guessed at:
#
#   1. The host itself, through the bridge gateway. `172.19.0.1:22`,
#      `:80` and `:443` all answered from inside the executor. A script
#      cannot log into sshd without a key, but user-authored code has no
#      business being able to knock on it, and "it needs a password" is
#      the weaker property we already rejected once for postgres.
#
#   2. `169.254.169.254`, the cloud metadata service. On this Hetzner
#      box that is harmless: user-data is empty and the public-keys list
#      is `[]`. On AWS, GCP, or Azure the same address serves the
#      instance's IAM credentials to anyone who asks. GratisGIS ships
#      this feature for other people to self-host, so leaving it open
#      would mean anyone enabling scripts on a cloud VM hands arbitrary
#      user code their instance role. That is the reason this file
#      exists.
#
# What is deliberately NOT blocked:
#
#   - The public internet. Fetching from a county REST endpoint is the
#     use case the whole feature exists for.
#   - RFC1918 generally. Tempting, and wrong: a self-hosted GIS portal
#     plausibly needs to reach an internal server at 10.x, and blanket
#     private-range blocking would break that while adding little the
#     two rules below do not already cover.
#
# The subnet is read from Docker at run time rather than hardcoded. A
# recreated network gets a new subnet, and a firewall rule pointing at
# the old one fails open silently, which is the worst way for a security
# control to fail.
set -euo pipefail

NETWORK="${GG_SCRIPT_NETWORK:-gratis-gis-prod_gg-script-net}"
CHAIN="GG-SCRIPT-EGRESS"
LINK_LOCAL="169.254.0.0/16"

if [[ $EUID -ne 0 ]]; then
  echo "FATAL: must run as root (iptables)." >&2
  exit 1
fi

# No network means the scripts profile has never been brought up here.
# Not an error: most deployments never turn scripts on, and the unit
# that calls this runs on every boot regardless.
if ! docker network inspect "$NETWORK" >/dev/null 2>&1; then
  echo "Script network '$NETWORK' does not exist; nothing to fence."
  exit 0
fi

SUBNET="$(docker network inspect "$NETWORK" \
  --format '{{range .IPAM.Config}}{{.Subnet}}{{end}}')"
if [[ -z "$SUBNET" ]]; then
  # Fail closed and loudly. Carrying on without rules would leave the
  # metadata service reachable while the unit reported success.
  echo "FATAL: could not read a subnet for '$NETWORK'." >&2
  exit 1
fi

# --- forwarded traffic: script network to link-local ---------------
#
# DOCKER-USER is evaluated before Docker's own FORWARD rules and is the
# documented place for operator policy; Docker will not clobber its
# contents when it rebuilds its chains.
iptables -N "$CHAIN" 2>/dev/null || true
iptables -F "$CHAIN"
iptables -A "$CHAIN" -d "$LINK_LOCAL" -j DROP
iptables -A "$CHAIN" -j RETURN

# Idempotent: drop any previous jump before adding this one, so
# re-running does not stack duplicates.
while iptables -C DOCKER-USER -s "$SUBNET" -j "$CHAIN" 2>/dev/null; do
  iptables -D DOCKER-USER -s "$SUBNET" -j "$CHAIN"
done
iptables -I DOCKER-USER 1 -s "$SUBNET" -j "$CHAIN"

# --- traffic to the host itself ------------------------------------
#
# This needs INPUT, not DOCKER-USER. A packet addressed to the bridge
# gateway is addressed to one of the host's own IPs, so it is delivered
# locally and never traverses FORWARD. Filtering it in DOCKER-USER would
# look right in a diff and do nothing at all.
#
# ESTABLISHED first so anything the HOST initiates toward a container
# still gets its replies. Only script-initiated connections are refused.
while iptables -C INPUT -s "$SUBNET" -j DROP 2>/dev/null; do
  iptables -D INPUT -s "$SUBNET" -j DROP
done
while iptables -C INPUT -s "$SUBNET" -m conntrack \
    --ctstate ESTABLISHED,RELATED -j ACCEPT 2>/dev/null; do
  iptables -D INPUT -s "$SUBNET" -m conntrack \
    --ctstate ESTABLISHED,RELATED -j ACCEPT
done
iptables -I INPUT 1 -s "$SUBNET" -j DROP
iptables -I INPUT 1 -s "$SUBNET" -m conntrack \
  --ctstate ESTABLISHED,RELATED -j ACCEPT

echo "Script network $SUBNET fenced: link-local and host both refused."
