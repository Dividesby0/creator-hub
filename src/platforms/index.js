'use strict';
const list = [
  require('./youtube'),
  require('./tiktok'),
  require('./instagram'),
  require('./threads'),
  require('./facebook'),
  require('./x')
];
const byId = Object.fromEntries(list.map(p => [p.id, p]));
module.exports = { list, byId };
