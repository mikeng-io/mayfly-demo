import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  PutCommand,
  QueryCommand,
  UpdateCommand,
  GetCommand,
} from '@aws-sdk/lib-dynamodb';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';

/**
 * mayfly-demo API (Lambda Function URL). Four routes:
 *   POST /trigger      — public; dispatches the showcase workflow (global cooldown)
 *   GET  /runs         — public; recent MicroVM receipts for the live feed
 *   POST /receipt      — from the Mayfly job (Bearer RECEIPT_TOKEN); stores one VM fingerprint
 *   GET  /attestation  — public; the control plane's own record for a given ?vm=<microvmId>
 *
 * On /receipt the guest tells us which VM it believes it ran on. That is self-reported, so we
 * check it against the control plane's attestation table — written when the VM was launched,
 * before the job could emit anything — and store the verdict. The two writers are independent:
 * the control plane's Lambda writes the attestation, the job inside the VM writes the receipt,
 * and this API only reads the former. /attestation exposes the same record so a reader can
 * repeat the comparison instead of trusting our verdict.
 */

const REGION = process.env.AWS_REGION;
const TABLE = process.env.DEMO_TABLE!;
const OWNER = process.env.GH_OWNER!;
const REPO = process.env.GH_REPO!;
const WORKFLOW = process.env.GH_WORKFLOW ?? 'showcase.yml';
const COOLDOWN = Number(process.env.COOLDOWN_SECONDS ?? '15');
const ORIGIN = process.env.ALLOW_ORIGIN ?? '*';
const TTL_SECONDS = 24 * 60 * 60;

/** SSM param published by MayflyStack holding the attestation table's name. */
const ATTESTATIONS_TABLE_PARAM = process.env.ATTESTATIONS_TABLE_PARAM ?? '/mayfly/attestationsTable';

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
  queryStringParameters?: Record<string, string | undefined>;
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

/**
 * Read the control plane's record for one MicroVM. Returns undefined when there is no
 * attestation, which is a real answer — "the control plane has no record of this VM" — and
 * must never be reported as corroboration. Failures are also undefined rather than thrown:
 * a receipt is still worth storing uncorroborated, and claiming less is the safe direction.
 */
interface Attestation {
  microvmId: string;
  runnerName?: string;
  jobId?: string;
  trust?: string;
  launchedAt?: number;
  terminatedAt?: number;
}
async function attestationFor(vm: string): Promise<Attestation | undefined> {
  try {
    const table = await param(ATTESTATIONS_TABLE_PARAM);
    if (!table) return undefined;
    const res = await ddb.send(new GetCommand({ TableName: table, Key: { microvmId: vm } }));
    return res.Item as Attestation | undefined;
  } catch (e) {
    console.error('[attestation] lookup failed', e);
    return undefined;
  }
}

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
      // 'yes'  — control plane independently recorded this VM serving this runner
      // 'no'   — it recorded a DIFFERENT runner for this VM (receipt is not trustworthy)
      // 'absent' / undefined — no record, or the lookup failed. Not corroboration.
      corroborated: i.corroborated,
      attestedRunner: i.attestedRunner,
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

  // Public, read-only view of the control plane's own record. This is what makes the
  // corroboration claim checkable rather than something the reader has to take on trust:
  // pick a vm id off the feed, look it up here, compare the runner name yourself.
  if (method === 'GET' && path.endsWith('/attestation')) {
    const vm = event.queryStringParameters?.vm;
    if (!vm) return json(400, { error: 'need ?vm=<microvmId>' });
    const att = await attestationFor(vm);
    if (!att) return json(404, { error: 'no attestation for that MicroVM id', vm });
    return json(200, {
      microvmId: att.microvmId,
      runnerName: att.runnerName,
      trust: att.trust,
      launchedAt: att.launchedAt,
      terminatedAt: att.terminatedAt,
      note: 'Written by the Mayfly control plane when this MicroVM was launched, before the job ran.',
    });
  }

  if (method === 'POST' && path.endsWith('/receipt')) {
    const auth = event.headers?.['authorization'] ?? event.headers?.['Authorization'];
    const secret = await param(process.env.RECEIPT_TOKEN_PARAM!);
    if (auth !== `Bearer ${secret}`) return json(401, { error: 'bad token' });
    const raw = event.isBase64Encoded ? Buffer.from(event.body ?? '', 'base64').toString() : event.body ?? '{}';
    const r = JSON.parse(raw) as Record<string, unknown>;

    // Check the guest's self-reported VM against the control plane's independent record.
    // Compare on runner name: the attestation says "microvm X served runner R", and the
    // receipt claims to come from runner R on microvm X. Agreement means two parties that
    // cannot see each other's writes described the same pairing.
    const vm = typeof r.vm === 'string' && r.vm && r.vm !== 'unknown' ? r.vm : undefined;
    const att = vm ? await attestationFor(vm) : undefined;
    let corroborated: 'yes' | 'no' | 'absent' = 'absent';
    if (att?.runnerName) corroborated = att.runnerName === r.host ? 'yes' : 'no';
    if (corroborated === 'no') {
      console.warn(
        `[receipt] MISMATCH vm=${vm} receipt-runner=${r.host} attested-runner=${att?.runnerName}`,
      );
    }

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
          // Control-plane-assigned MicroVM id — the only field here that reliably
          // distinguishes one VM from another. kernel and hostname come from the image so
          // they never vary; boot_id has been observed shared across two VMs with different
          // control-plane ids, so it cannot be trusted to differ either.
          // Defaulted: the doc client rejects undefined attribute values.
          vm: r.vm ?? 'unknown',
          corroborated,
          attestedRunner: att?.runnerName ?? 'none',
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
