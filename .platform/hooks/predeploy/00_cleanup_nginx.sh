#!/bin/bash
set -xe

echo "Cleaning old nginx config files..."

rm -f /etc/nginx/conf.d/client_max_body_size.conf || true
rm -f /etc/nginx/conf.d/sse.conf || true
rm -f /etc/nginx/conf.d/00_proxy.conf || true

# Remove temporary EB proxy files
rm -f /var/proxy/staging/nginx/conf.d/client_max_body_size.conf || true
rm -f /var/proxy/staging/nginx/conf.d/sse.conf || true

echo "Cleanup complete."
