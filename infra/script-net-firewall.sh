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

# How much of the internet a script may reach.
#
#   open         (default) the public internet. What the feature is for:
#                refreshing a layer from a county REST endpoint needs to
#                leave the building.
#   portal-only  nothing outside this network. Scripts can still use the
#                whole portal API, so they can read layers, compute, and
#                write results, which is most of what people write.
#
# portal-only exists so a public demo can offer scripts at all. The
# sandbox holds either way; the thing that makes open egress unwise in
# front of strangers is not that they might escape it, but that they can
# make requests from your server's address, and the abuse report has
# your name on it. Turning egress off removes the reason to say no.
#
# Deliberately not the default. A self-hoster who turns scripts on has
# already decided who can create one, and silently crippling the
# headline use case would be a worse surprise than the one it prevents.
SCRIPT_EGRESS="${SCRIPT_EGRESS:-open}"
case "$SCRIPT_EGRESS" in
  open|portal-only) ;;
  *)
    echo "FATAL: SCRIPT_EGRESS must be 'open' or 'portal-only', got '$SCRIPT_EGRESS'." >&2
    exit 1
    ;;
esac

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

# Fence the EXECUTOR, by address, not the whole subnet.
#
# The first version matched `-s $SUBNET` and broke production. portal-api
# is on this network too, so it inherited a fence meant for user code:
# its route to `storage.gratisgis.org` hairpins through the published
# port, Docker DNATs that to caddy on the other bridge, and the "no other
# Docker network" rule silently dropped it. The API then hung on boot
# with no error, because a DROP is silent and the socket just never
# connects. Both replicas mapped every route, logged leader election, and
# stopped before listening. It took a rollback and a wrong hypothesis to
# find, and the reason it was hard is that the fence looked like it was
# about a network when it is actually about one container.
#
# Only script-executor runs code the portal did not write. portal-api and
# script-runner are ours and must not be fenced. Matching them by address
# is exact, and re-reading it every five minutes handles the address
# changing when the container is recreated.
# Our INPUT rules are recognised by their source lying inside the script
# subnet. Narrow enough not to touch anybody else's firewall, and it
# still finds rules written for an address the executor has since lost.
GG_INPUT_MARK="${SUBNET%%.*}."
EXECUTOR_MATCH="${GG_SCRIPT_EXECUTOR_NAME:-script-executor}"
EXECUTOR_IPS="$(docker network inspect "$NETWORK" \
  --format '{{range .Containers}}{{.Name}} {{.IPv4Address}}
{{end}}' \
  | awk -v m="$EXECUTOR_MATCH" '$1 ~ m {split($2, a, "/"); print a[1]}')"

if [[ -z "$EXECUTOR_IPS" ]]; then
  # Not running, so there is nothing executing user code and nothing to
  # fence. Leaving no rules is correct here, and leaving stale rules
  # pointed at a recycled address would be worse than none.
  echo "No executor on '$NETWORK'; removing any previous rules."
fi

# Every other Docker network on this host. Enumerated rather than
# hardcoded for the same reason as the script subnet, and because a
# deployment can add networks we have never heard of.
#
# This is what actually closes the published-port hairpin. Blocking the
# host in INPUT is not enough on its own: Docker publishes caddy on
# 0.0.0.0:80 and :443 with a DNAT rule in nat/PREROUTING, which rewrites
# the destination to caddy's container address before the packet reaches
# INPUT. It therefore leaves as FORWARD traffic to another network and
# never touches the host-bound rule at all. Measured: after the first
# version of this script, gateway :22 was refused while :80 and :443
# were still wide open.
#
# The general statement is the honest one anyway. A script may reach its
# own network and the public internet. It has no business on any other
# Docker network on the box, whether that network exists today or gets
# added next year.
OTHER_SUBNETS="$(docker network inspect \
  $(docker network ls -q) \
  --format '{{range .IPAM.Config}}{{.Subnet}} {{end}}' 2>/dev/null \
  | tr ' ' '\n' | grep -v '^$' | grep -vFx "$SUBNET" | sort -u)"

# --- forwarded traffic out of the script network --------------------
#
# DOCKER-USER is evaluated before Docker's own FORWARD rules and is the
# documented place for operator policy; Docker will not clobber its
# contents when it rebuilds its chains.
iptables -N "$CHAIN" 2>/dev/null || true
iptables -F "$CHAIN"
iptables -A "$CHAIN" -d "$LINK_LOCAL" -j DROP
for other in $OTHER_SUBNETS; do
  iptables -A "$CHAIN" -d "$other" -j DROP
done
if [[ "$SCRIPT_EGRESS" == "portal-only" ]]; then
  # Everything that is not this network. Traffic to portal-api never
  # reaches this chain at all: same-bridge delivery, so there is nothing
  # to allow explicitly and no rule here that could accidentally widen
  # it. DNS is likewise untouched, because Docker's resolver answers
  # inside the container's own namespace.
  iptables -A "$CHAIN" ! -d "$SUBNET" -j DROP
fi
iptables -A "$CHAIN" -j RETURN

# Idempotent, and it must clean up addresses the executor no longer has.
# Sweep every rule in DOCKER-USER that jumps to our chain, whatever its
# source, then add one per current executor address. A rule left pointing
# at a recycled address would fence whichever container inherits it,
# which is exactly the failure this file already caused once.
while read -r stale; do
  [[ -n "$stale" ]] && iptables -D DOCKER-USER -s "$stale" -j "$CHAIN" 2>/dev/null || true
done < <(iptables -S DOCKER-USER 2>/dev/null \
  | awk -v c="$CHAIN" '$0 ~ ("-j " c) {for (i=1;i<NF;i++) if ($i=="-s") print $(i+1)}')

for ip in $EXECUTOR_IPS; do
  iptables -I DOCKER-USER 1 -s "$ip" -j "$CHAIN"
done

# --- traffic to the host itself ------------------------------------
#
# This needs INPUT, not DOCKER-USER. A packet addressed to the bridge
# gateway is addressed to one of the host's own IPs, so it is delivered
# locally and never traverses FORWARD. Filtering it in DOCKER-USER would
# look right in a diff and do nothing at all.
#
# ESTABLISHED first so anything the HOST initiates toward a container
# still gets its replies. Only script-initiated connections are refused.
while read -r stale; do
  [[ -z "$stale" ]] && continue
  iptables -D INPUT -s "$stale" -j DROP 2>/dev/null || true
  iptables -D INPUT -s "$stale" -m conntrack \
    --ctstate ESTABLISHED,RELATED -j ACCEPT 2>/dev/null || true
done < <(iptables -S INPUT 2>/dev/null \
  | awk -v n="$GG_INPUT_MARK" '$0 ~ n {for (i=1;i<NF;i++) if ($i=="-s") print $(i+1)}' \
  | sort -u)

for ip in $EXECUTOR_IPS; do
  iptables -I INPUT 1 -s "$ip" -j DROP
  iptables -I INPUT 1 -s "$ip" -m conntrack \
    --ctstate ESTABLISHED,RELATED -j ACCEPT
done

echo "Script executor(s) fenced: $(echo $EXECUTOR_IPS | tr '\n' ' ')"
echo "  link-local:     $LINK_LOCAL DROP"
echo "  other networks: $(echo "$OTHER_SUBNETS" | tr '\n' ' ')DROP"
echo "  host itself:    DROP (executor-initiated only)"
echo "  NOT fenced:     portal-api and script-runner, which share this network"
if [[ "$SCRIPT_EGRESS" == "portal-only" ]]; then
  echo "  internet:       DROP (SCRIPT_EGRESS=portal-only)"
else
  echo "  internet:       allowed (SCRIPT_EGRESS=open)"
fi
