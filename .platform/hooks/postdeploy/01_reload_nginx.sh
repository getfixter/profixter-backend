#!/usr/bin/env bash
set -e
sudo service nginx reload || sudo systemctl reload nginx || true
