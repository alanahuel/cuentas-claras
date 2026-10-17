#!/usr/bin/env bash
set -euo pipefail
umask 077
exec 9>/run/cuentas-backup.lock
flock -n 9 || exit 0
snapshot=$(mktemp -d /var/lib/cuentas-backup.XXXXXX)
trap 'rm -rf -- "$snapshot"' EXIT
cd /opt/cuentas/backend
DATA_DIR=/var/lib/cuentas /opt/cuentas/venv/bin/python -m app.backup "$snapshot/snapshot"
recipient=$(cat /etc/cuentas/backup-recipient.txt)
archive="/var/backups/cuentas/cuentas-$(date -u +%Y%m%dT%H%M%SZ).tar.gz.age"
tar -C "$snapshot/snapshot" -czf - . | age -r "$recipient" -o "$archive"
# Retain 14 daily archives. Only our own encrypted files are eligible.
find /var/backups/cuentas -maxdepth 1 -name 'cuentas-*.tar.gz.age' -mtime +14 -delete
