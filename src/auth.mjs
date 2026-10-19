import {randomBytes,scrypt as scryptCallback,timingSafeEqual} from 'node:crypto';
import {promisify} from 'node:util';
const scrypt=promisify(scryptCallback);
const cost=32768,blockSize=8,parallelization=3,maxmem=64*1024*1024;
export const normalizeEmail=value=>String(value??'').trim().toLowerCase();
export const validEmail=value=>value.length<=254&&/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
export const validPassword=value=>typeof value==='string'&&[...value].length>=12&&Buffer.byteLength(value,'utf8')<=256;
export async function hashPassword(password){if(!validPassword(password))throw Error('invalid_password');const salt=randomBytes(16);const derived=await scrypt(password,salt,32,{cost,blockSize,parallelization,maxmem});return `scrypt$${cost}$${blockSize}$${parallelization}$${salt.toString('base64url')}$${derived.toString('base64url')}`}
export async function verifyPassword(password,stored){if(typeof password!=='string'||!stored)return false;const parts=stored.split('$');if(parts.length!==6||parts[0]!=='scrypt')return false;const [N,r,p]=parts.slice(1,4).map(Number);if(N!==cost||r!==blockSize||p!==parallelization)return false;const salt=Buffer.from(parts[4],'base64url'),expected=Buffer.from(parts[5],'base64url');if(salt.length!==16||expected.length!==32)return false;const actual=await scrypt(password,salt,32,{cost:N,blockSize:r,parallelization:p,maxmem});return timingSafeEqual(actual,expected)}
export function readCookie(req,name){for(const part of String(req.headers.cookie??'').split(';')){const i=part.indexOf('=');if(i>=0&&part.slice(0,i).trim()===name)return part.slice(i+1).trim()}return ''}
export const sessionCookie=(value,secure,maxAge)=>`inbox_session=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure?'; Secure':''}`;
