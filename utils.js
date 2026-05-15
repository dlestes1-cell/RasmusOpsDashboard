// utils.js
function uid() { return Math.random().toString(36).slice(2, 10); }
function now() { return Date.now(); }

module.exports = { uid, now };
