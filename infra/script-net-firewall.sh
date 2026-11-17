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
#
# The systemd unit passes it from infra/.env.prod. deploy.sh runs this
# through `sudo -n`, which clears the environment, so an unset value is
# read from the same file here. Without that, every deploy rebuilt the
# chain as `open` until the next timer tick.
GG_ENV_FILE="${GG_ENV_FILE:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/.env.prod}"
if [[ -z "${SCRIPT_EGRESS:-}" && -r "$GG_ENV_FILE" ]]; then
  SCRIPT_EGRESS="$(sed -n "s/^[[:space:]]*SCRIPT_EGRESS[[:space:]]*=[[:space:]]*['\"]\{0,1\}\([^'\"[:space:]]*\).*/\1/p" "$GG_ENV_FILE" | tail -n 1)"
fi
SCRIPT_EGRESS="${SCRIPT_EGRESS:-open}"
case "$SCRIPT_EGRESS" in
  open|portal-only) ;;
  *)
    echo "FATAL: SCRIPT_EGRESS must be 'open' or 'portal-only', got '$SCRIPT_EGRESS'." >&2
    exit 1
    ;;
esac

# The unit test drives this script against fake iptables and docker
# binaries; nothing else should set this.
if [[ $EUID -ne 0 && "${GG_FENCE_TEST_ALLOW_NONROOT:-}" != "1" ]]; then
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
# Our INPUT rules carry this comment, and the sweep below touches only
# rules that carry it. An earlier version recognised them by text (any
# INPUT line containing the subnet's first octet, "172." in practice)
# and so deleted an operator's own `-s 172.16.0.0/12 -j DROP` every five
# minutes.
FENCE_TAG="gg-script-fence"
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
  | tr ' ' '\n' | grep -v '^$' | grep -vFx "$SUBNET" | grep -v ':' | sort -u)"
# IPv4 only (grep -v ':'): iptables refuses an IPv6 subnet, and under
# set -e that stopped the script with the chain half built.

# --- forwarded traffic out of the script network --------------------
#
# DOCKER-USER is evaluated before Docker's own FORWARD rules and is the
# documented place for operator policy; Docker will not clobber its
# contents when it rebuilds its chains.
# Built as a new chain and swapped in: flushing the live chain and
# adding rules one by one left the executor unfenced for a moment on
# every run. The new jumps go in before the old ones come out, so some
# fence is always in place.
NEXT="${CHAIN}-next"
iptables -N "$NEXT" 2>/dev/null || iptables -F "$NEXT"
iptables -A "$NEXT" -d "$LINK_LOCAL" -j DROP
for other in $OTHER_SUBNETS; do
  iptables -A "$NEXT" -d "$other" -j DROP
done
if [[ "$SCRIPT_EGRESS" == "portal-only" ]]; then
  # Everything that is not this network. Traffic to portal-api never
  # reaches this chain at all: same-bridge delivery, so there is nothing
  # to allow explicitly and no rule here that could accidentally widen
  # it. DNS is likewise untouched, because Docker's resolver answers
  # inside the container's own namespace.
  iptables -A "$NEXT" ! -d "$SUBNET" -j DROP
fi
iptables -A "$NEXT" -j RETURN

for ip in $EXECUTOR_IPS; do
  iptables -I DOCKER-USER 1 -s "$ip" -j "$NEXT"
done

# Idempotent, and it must clean up addresses the executor no longer has.
# Sweep every rule in DOCKER-USER that jumps to the old chain, whatever
# its source. A rule left pointing at a recycled address would fence
# whichever container inherits it, which is exactly the failure this
# file already caused once.
while read -r stale; do
  [[ -n "$stale" ]] && iptables -D DOCKER-USER -s "$stale" -j "$CHAIN" 2>/dev/null || true
done < <(iptables -S DOCKER-USER 2>/dev/null \
  | awk -v c="$CHAIN" '$0 ~ ("-j " c "( |$)") {for (i=1;i<NF;i++) if ($i=="-s") print $(i+1)}')
iptables -F "$CHAIN" 2>/dev/null || true
iptables -X "$CHAIN" 2>/dev/null || true
# Rename carries the jumps that point at it.
iptables -E "$NEXT" "$CHAIN"

# --- traffic to the host itself ------------------------------------
#
# This needs INPUT, not DOCKER-USER. A packet addressed to the bridge
# gateway is addressed to one of the host's own IPs, so it is delivered
# locally and never traverses FORWARD. Filtering it in DOCKER-USER would
# look right in a diff and do nothing at all.
#
# ESTABLISHED first so anything the HOST initiates toward a container
# still gets its replies. Only script-initiated connections are refused.
# Remove one INPUT rule given in `iptables -S` form.
delete_input_rule() {
  local rule="$1"
  local -a spec
  read -ra spec <<< "${rule#-A INPUT }"
  iptables -D INPUT "${spec[@]}" 2>/dev/null || true
}

# Our own rules, by tag, listed now and removed only after the new ones
# are in (below), so the host is never unfenced in between. This also
# finds rules written for an address the executor has since lost.
OLD_INPUT_RULES="$(iptables -S INPUT 2>/dev/null | grep -F -- "--comment $FENCE_TAG" || true)"

# One-time cleanup of rules written by versions before the tag. Only the
# exact two shapes those versions wrote, untagged, for a single address
# that lies inside the script subnet by arithmetic, not by text.
while IFS= read -r rule; do
  [[ -n "$rule" ]] && delete_input_rule "$rule"
done < <(iptables -S INPUT 2>/dev/null | awk -v subnet="$SUBNET" '
  function ip2n(ip,   a) { split(ip, a, "."); return ((a[1] * 256 + a[2]) * 256 + a[3]) * 256 + a[4] }
  BEGIN {
    split(subnet, s, "/")
    size = 2 ^ (32 - s[2])
    net = int(ip2n(s[1]) / size) * size
  }
  $1 == "-A" && $2 == "INPUT" && $3 == "-s" {
    drop = (NF == 6 && $5 == "-j" && $6 == "DROP")
    est = (NF == 10 && $5 == "-m" && $6 == "conntrack" && $7 == "--ctstate" \
           && $8 ~ /ESTABLISHED/ && $8 ~ /RELATED/ && $9 == "-j" && $10 == "ACCEPT")
    if (!drop && !est) next
    split($4, h, "/")
    if (h[2] != "32") next
    n = ip2n(h[1])
    if (n >= net && n < net + size) print
  }')

for ip in $EXECUTOR_IPS; do
  iptables -I INPUT 1 -s "$ip" -m comment --comment "$FENCE_TAG" -j DROP
  iptables -I INPUT 1 -s "$ip" -m conntrack \
    --ctstate ESTABLISHED,RELATED -m comment --comment "$FENCE_TAG" -j ACCEPT
done
# Each listed rule is removed once. For a current address that removes
# one of two identical copies and the other stays; a lost address goes.
while IFS= read -r rule; do
  [[ -n "$rule" ]] && delete_input_rule "$rule"
done <<< "$OLD_INPUT_RULES"

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
