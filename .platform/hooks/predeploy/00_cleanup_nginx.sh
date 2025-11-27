#!/bin/bash
echo "Cleaning old nginx config..."

rm -f /etc/nginx/conf.d/client_max_body_size.conf || true
rm -f /etc/nginx/conf.d/client_max_body_size* || true

echo "Cleanup complete."
