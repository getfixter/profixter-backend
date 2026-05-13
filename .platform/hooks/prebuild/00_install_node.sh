#!/bin/bash

echo "Installing Node.js 18 using NVM..."

export NVM_DIR="/home/webapp/.nvm"
mkdir -p $NVM_DIR

curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
source $NVM_DIR/nvm.sh

nvm install 18
nvm alias default 18
nvm use 18

ln -sf $NVM_DIR/versions/node/v18*/bin/node /usr/bin/node
ln -sf $NVM_DIR/versions/node/v18*/bin/npm /usr/bin/npm

echo "Node version:"
node -v
echo "NPM version:"
npm -v
