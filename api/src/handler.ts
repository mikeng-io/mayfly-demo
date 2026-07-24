import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';

/**
 * mayfly-demo API (Lambda Function URL). Three routes:
 *   POST /trigger  — public; dispatches the showcase workflow (rate-limited by a global cooldown)
 *   GET  /runs     — public; recent MicroVM receipts for the live feed
 *   POST /receipt  — from the Mayfly job (Bearer RECEIPT_TOKEN); stores one VM fingerprint
 */

const REGION = process.env.AWS_REGION;
const TABLE = process.env.DEMO_TABLE!;
const OWNER = process.env.GH_OWNER!;
const REPO = process.env.GH_REPO!;
const WORKFLOW = process.env.GH_WORKFLOW ?? 'showcase.yml';
const COOLDOWN = Number(process.env.COOLDOWN_SECONDS ?? '15');
const ORIGIN = process.env.ALLOW_ORIGIN ?? '*';
const TTL_SECONDS = 24 * 60 * 60;

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));
const ssm = new SSMClient({ region: REGION });
const cache: Record<string, string> = {};
async function param(name: string): Promise<string> {
  if (cache[name]) return cache[name];
  const r = await ssm.send(new GetParameterCommand({ Name: name, WithDecryption: true }));
  return (cache[name] = r.Parameter?.Value ?? '');
}

interface Evt {
  requestContext?: { http?: { method?: string; path?: string } };
  rawPath?: string;
  headers?: Record<string, string | undefined>;
  body?: string | null;
  isBase64Encoded?: boolean;
}
const json = (statusCode: number, obj: unknown) => ({
  statusCode,
  headers: {
    'content-type': 'application/json',
    'access-control-allow-origin': ORIGIN,
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'access-control-allow-headers': 'authorization,content-type',
  },
  body: JSON.stringify(obj),
});

/** Global cooldown so the public Trigger button can't be spammed into a MicroVM flood. */
async function withinCooldown(nowSec: number): Promise<boolean> {
  try {
    await ddb.send(
      new UpdateCommand({
        TableName: TABLE,
        Key: { pk: 'gate', createdAt: 0 },
        UpdateExpression: 'SET lastTrigger = :now, expiresAt = :ttl',
        ConditionExpression: 'attribute_not_exists(lastTrigger) OR lastTrigger < :threshold',
        ExpressionAttributeValues: {
          ':now': nowSec,
          ':threshold': nowSec - COOLDOWN,
          ':ttl': nowSec + TTL_SECONDS,
        },
      }),
    );
    return false; // claimed the slot → not cooling down
  } catch (e) {
    if ((e as { name?: string }).name === 'ConditionalCheckFailedException') return true;
    throw e;
  }
}

async function dispatch(): Promise<void> {
  const token = await param(process.env.GH_TOKEN_PARAM!);
  const res = await fetch(
    `https://api.github.com/repos/${OWNER}/${REPO}/actions/workflows/${WORKFLOW}/dispatches`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
      },
      body: JSON.stringify({ ref: 'main' }),
    },
  );
  if (!res.ok) throw new Error(`dispatch failed: ${res.status}`);
}

export async function handler(event: Evt) {
  const method = event.requestContext?.http?.method ?? 'GET';
  const path = event.requestContext?.http?.path ?? event.rawPath ?? '/';
  const nowSec = Math.floor(Date.now() / 1000);

  if (method === 'OPTIONS') return json(204, {});

  if (method === 'POST' && path.endsWith('/trigger')) {
    if (await withinCooldown(nowSec)) return json(429, { error: `cooling down (${COOLDOWN}s)` });
    try {
      await dispatch();
      return json(202, { ok: true });
    } catch (e) {
      return json(502, { error: (e as Error).message });
    }
  }

  if (method === 'GET' && path.endsWith('/runs')) {
    const res = await ddb.send(
      new QueryCommand({
        TableName: TABLE,
        KeyConditionExpression: 'pk = :p',
        ExpressionAttributeValues: { ':p': 'run' },
        ScanIndexForward: false,
        Limit: 8,
      }),
    );
    const runs = (res.Items ?? []).map((i) => ({
      // Full runner name. Truncating to 12 chars rendered distinct VMs
      // (mayfly-89544147766 vs mayfly-89544261359) as an identical "mayfly-89544".
      id: String(i.host ?? i.id ?? '').slice(0, 64) || 'unknown',
      arch: i.arch,
      kernel: i.kernel,
      vm: i.vm,
      boot: i.boot,
      tmp: i.tmp,
      image: i.image,
      sha: i.sha,
      dur: i.durMs,
      at: new Date((i.createdAt as number) * 1000).toLocaleTimeString(),
      state: 'destroyed',
    }));
    return json(200, { runs });
  }

  if (method === 'POST' && path.endsWith('/receipt')) {
    const auth = event.headers?.['authorization'] ?? event.headers?.['Authorization'];
    const secret = await param(process.env.RECEIPT_TOKEN_PARAM!);
    if (auth !== `Bearer ${secret}`) return json(401, { error: 'bad token' });
    const raw = event.isBase64Encoded ? Buffer.from(event.body ?? '', 'base64').toString() : event.body ?? '{}';
    const r = JSON.parse(raw) as Record<string, unknown>;
    await ddb.send(
      new PutCommand({
        TableName: TABLE,
        Item: {
          pk: 'run',
          createdAt: nowSec,
          id: r.id,
          host: r.host,
          arch: r.arch,
          kernel: r.kernel,
          // Control-plane-assigned MicroVM id — the only field that distinguishes one VM
          // from another. Everything the guest can read about itself (kernel, hostname,
          // even boot_id) is identical across VMs, because they all restore from one
          // build snapshot. Defaulted: the doc client rejects undefined attribute values.
          vm: r.vm ?? 'unknown',
          boot: r.boot ?? 'unknown',
          image: r.image ?? 'mayfly-runner',
          sha: r.sha,
          durMs: r.durMs,
          tmp: r.tmp,
          expiresAt: nowSec + TTL_SECONDS,
        },
      }),
    );
    return json(201, { ok: true });
  }

  return json(404, { error: 'not found' });
}
