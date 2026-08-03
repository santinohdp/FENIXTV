// crypto.js
//
// AES/CBC/PKCS7Padding — igual a lo que hace CryptoUtils.decryptAES2() en la
// app Android ya parcheada (la segunda capa que dependía del Firebase de
// pluscapelian fue removida del lado del APK, así que acá mandamos "iv"/"iv2"
// en base64 plano, tal cual la app los usa directo).

const crypto = require("crypto");

function generateKeyIv() {
  const key = crypto.randomBytes(32); // AES-256
  const iv = crypto.randomBytes(16); // 16 bytes siempre para AES/CBC
  return { key, iv };
}

function encryptAES(plainText, key, iv) {
  const cipher = crypto.createCipheriv("aes-256-cbc", key, iv);
  const encrypted = Buffer.concat([
    cipher.update(String(plainText), "utf8"),
    cipher.final(),
  ]);
  return encrypted.toString("base64");
}

function keyIvToBase64({ key, iv }) {
  return { keyB64: key.toString("base64"), ivB64: iv.toString("base64") };
}

module.exports = { generateKeyIv, encryptAES, keyIvToBase64 };
