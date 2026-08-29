#!/usr/bin/env bash
# Copied root-owned to /usr/local/bin/chip402ctl. The only thing sudo and polkit will run.
exec /usr/local/lib/chip402/node /usr/local/lib/chip402/bin/chip402ctl.ts "$@"
