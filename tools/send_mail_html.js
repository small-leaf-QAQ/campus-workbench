#!/usr/bin/env node
/**
 * 校园生活工作台 · 每日提醒邮件发送器（HTML / SMTP）
 *
 * 为什么单独写：~/.workbuddy/skills/qq-email/scripts/send.js 只设置 `text:`，
 * 发出去会是一堆 HTML 标签；而我们的提醒邮件是带配色的 HTML。这里补上 `html:`。
 *
 * 凭证来源（按优先级）：
 *   1. 环境变量 QQ_EMAIL_ACCOUNT / QQ_EMAIL_AUTH_CODE
 *   2. 本地凭证文件 %USERPROFILE%\.workbuddy\qq-mail-credentials.json
 *      {"account":"xxx@qq.com","authCode":"xxxxxxxxxxxxxxxx"}
 *   两者都没有 → 打印可读错误并以退出码 2 结束（不尝试任何猜测）。
 *
 * 用法：
 *   node tools/send_mail_html.js --to a@b.com --subject "主题" --html-file mail.html
 *   node tools/send_mail_html.js --to a@b.com --subject "主题" --html-stdin < mail.html
 *   node tools/send_mail_html.js --check          # 只校验凭证与连通性，不发信
 */

import { createRequire } from 'node:module';
import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// nodemailer 装在 qq-email 技能目录下，从项目目录解析不到，这里显式指过去
const SKILL_DIR = join(homedir(), '.workbuddy', 'skills', 'qq-email');
let nodemailer;
try {
  const req = createRequire(join(SKILL_DIR, 'package.json'));
  nodemailer = req('nodemailer');
} catch (e) {
  console.error('[FAIL] 无法加载 nodemailer。请先在技能目录执行 npm install：');
  console.error('       ' + SKILL_DIR);
  console.error('       原因：' + e.message);
  process.exit(3);
}

const CRED_FILE = join(homedir(), '.workbuddy', 'qq-mail-credentials.json');

function loadCredentials() {
  const envAccount = (process.env.QQ_EMAIL_ACCOUNT || '').trim();
  const envCode = (process.env.QQ_EMAIL_AUTH_CODE || '').trim();
  if (envAccount && envCode) {
    return { account: envAccount, authCode: envCode, from: 'env' };
  }
  if (existsSync(CRED_FILE)) {
    try {
      const j = JSON.parse(readFileSync(CRED_FILE, 'utf8'));
      const account = String(j.account || '').trim();
      const authCode = String(j.authCode || '').trim();
      if (account && authCode) return { account, authCode, from: 'file' };
      console.error('[FAIL] 凭证文件存在但 account / authCode 为空：' + CRED_FILE);
      process.exit(2);
    } catch (e) {
      console.error('[FAIL] 凭证文件解析失败：' + CRED_FILE);
      console.error('       原因：' + e.message);
      process.exit(2);
    }
  }
  console.error('[FAIL] 找不到邮箱凭证。请二选一：');
  console.error('       1) 设置环境变量 QQ_EMAIL_ACCOUNT 与 QQ_EMAIL_AUTH_CODE');
  console.error('       2) 创建 ' + CRED_FILE);
  console.error('          内容：{"account":"xxx@qq.com","authCode":"<授权码>"}');
  process.exit(2);
}

/* ---------- 参数 ---------- */
const argv = process.argv.slice(2);
function argOf(name) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

if (argv.includes('--help') || argv.includes('-h')) {
  console.log('用法：node tools/send_mail_html.js --to <收件人> --subject <主题> --html-file <文件>');
  console.log('      node tools/send_mail_html.js --check');
  process.exit(0);
}

const cred = loadCredentials();

const transporter = nodemailer.createTransport({
  host: 'smtp.qq.com',
  port: 465,
  secure: true,
  auth: { user: cred.account, pass: cred.authCode },
});

async function main() {
  if (argv.includes('--check')) {
    await transporter.verify();
    console.log('[OK] 凭证可用（来源：' + cred.from + '），SMTP smtp.qq.com:465 连通。账号：' + cred.account);
    return;
  }

  const to = (argOf('--to') || '').trim();
  const subject = argOf('--subject') || '';
  if (!to) {
    console.error('[FAIL] 缺少 --to');
    process.exit(2);
  }

  let html = '';
  const file = argOf('--html-file');
  if (file) {
    html = readFileSync(file, 'utf8');
  } else if (argv.includes('--html-stdin')) {
    html = readFileSync(0, 'utf8');
  } else {
    console.error('[FAIL] 缺少 --html-file 或 --html-stdin');
    process.exit(2);
  }
  if (!html.trim()) {
    console.error('[FAIL] 邮件正文为空，拒绝发送');
    process.exit(2);
  }

  // 纯文本兜底：粗暴去标签，够用即可（收件人绝大多数看 HTML 版）
  const text = html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(div|p|tr|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  const info = await transporter.sendMail({
    from: `"校园生活工作台" <${cred.account}>`,
    to,
    subject,
    text,
    html,
  });

  console.log('[OK] 已发送');
  console.log('messageId: ' + info.messageId);
  console.log('收件人  : ' + to);
  console.log('主题    : ' + subject);
  console.log('凭证来源: ' + cred.from);
}

main().catch((e) => {
  console.error('[FAIL] 发送失败：' + (e && e.message ? e.message : String(e)));
  if (e && e.response) console.error('       SMTP 响应：' + e.response);
  process.exit(1);
});
