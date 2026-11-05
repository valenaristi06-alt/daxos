const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const base = path.join(root, 'node_modules/@whiskeysockets/baileys');

const files = [
  'lib/Socket/socket.js',
  'lib/Utils/companion-reg-client-utils.js'
];

const pkg = require(path.join(base, 'package.json'));

if (pkg.version !== '7.0.0-rc14') {
  throw new Error('Version inesperada: ' + pkg.version);
}

for (const file of files) {
  const source = path.join(root, 'patches/baileys', file);
  const target = path.join(base, file);

  if (fs.existsSync(source) === false) {
    throw new Error('Falta el parche: ' + file);
  }

  fs.copyFileSync(source, target);
  console.log('Aplicado: ' + file);
}

console.log('Parche Baileys aplicado correctamente.');
