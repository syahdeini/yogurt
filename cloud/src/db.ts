import { randomUUID } from 'node:crypto'
import sql from 'mssql'
import type { CloudSegment } from './speech/parse.js'
import type { ActionItem } from './summary/parse.js'

export type TrackState = {
  track: 'me' | 'them'
  blobName: string
  contentType: string
  speechUrl?: string
  speechStatus?: 'running' | 'succeeded' | 'failed'
}

export type MeetingRow = {
  id: string
  user_oid: string
  local_id: string
  title: string | null
  status: string
  tracks: string
  language: string | null
  error: string | null
}

let pool: sql.ConnectionPool | undefined

export async function getPool(): Promise<sql.ConnectionPool> {
  if (pool?.connected) return pool
  const server = process.env.SQL_SERVER
  const database = process.env.SQL_DATABASE
  if (!server || !database) throw new Error('SQL_SERVER and SQL_DATABASE are required')
  pool = new sql.ConnectionPool({
    server, database,
    options: { encrypt: true, trustServerCertificate: false },
    authentication: { type: 'azure-active-directory-default', options: {} },
  })
  await pool.connect()
  return pool
}

const userContext = `
EXEC sp_set_session_context @key = N'bypass', @value = NULL;
EXEC sp_set_session_context @key = N'user_oid', @value = @oid;`

const workerContext = `
EXEC sp_set_session_context @key = N'user_oid', @value = NULL;
EXEC sp_set_session_context @key = N'bypass', @value = N'worker';`

async function query(context: string, text: string, bind: (request: sql.Request) => void) {
  const request = (await getPool()).request()
  bind(request)
  return request.query(context + text)
}

export function tracksOf(raw: string | null): TrackState[] {
  if (!raw) return []
  const parsed = JSON.parse(raw) as TrackState[]
  return Array.isArray(parsed) ? parsed : []
}

export async function findOwnByLocal(oid: string, localId: string): Promise<MeetingRow | undefined> {
  const result = await query(userContext, `
    SELECT id, user_oid, local_id, title, status, tracks, language, error
    FROM notes.meetings WHERE user_oid = @oid AND local_id = @localId`, (request) => {
    request.input('oid', sql.NVarChar(64), oid)
    request.input('localId', sql.NVarChar(64), localId)
  })
  return result.recordset[0] as MeetingRow | undefined
}

export async function findOwn(oid: string, id: string): Promise<MeetingRow | undefined> {
  const result = await query(userContext, `
    SELECT id, user_oid, local_id, title, status, tracks, language, error
    FROM notes.meetings WHERE user_oid = @oid AND id = @id`, (request) => {
    request.input('oid', sql.NVarChar(64), oid)
    request.input('id', sql.UniqueIdentifier, id)
  })
  return result.recordset[0] as MeetingRow | undefined
}

export async function insertMeeting(row: { id: string; oid: string; localId: string; title: string; tracks: TrackState[] }): Promise<void> {
  await query(userContext, `
    INSERT INTO notes.meetings (id, user_oid, local_id, title, status, tracks)
    VALUES (@id, @oid, @localId, @title, N'uploaded', @tracks)`, (request) => {
    request.input('oid', sql.NVarChar(64), row.oid)
    request.input('id', sql.UniqueIdentifier, row.id)
    request.input('localId', sql.NVarChar(64), row.localId)
    request.input('title', sql.NVarChar(400), row.title.slice(0, 400))
    request.input('tracks', sql.NVarChar(sql.MAX), JSON.stringify(row.tracks))
  })
}

export async function saveTracks(id: string, oid: string, tracks: TrackState[], status: string): Promise<void> {
  await query(workerContext, `
    UPDATE notes.meetings SET tracks = @tracks, status = @status, updated_at = SYSUTCDATETIME()
    WHERE id = @id AND user_oid = @oid`, (request) => {
    request.input('id', sql.UniqueIdentifier, id)
    request.input('oid', sql.NVarChar(64), oid)
    request.input('tracks', sql.NVarChar(sql.MAX), JSON.stringify(tracks))
    request.input('status', sql.NVarChar(32), status)
  })
}

export async function markFailed(id: string, oid: string, error: string): Promise<void> {
  await query(workerContext, `
    UPDATE notes.meetings SET status = N'failed', error = @error, updated_at = SYSUTCDATETIME()
    WHERE id = @id AND user_oid = @oid AND status <> N'ready'`, (request) => {
    request.input('id', sql.UniqueIdentifier, id)
    request.input('oid', sql.NVarChar(64), oid)
    request.input('error', sql.NVarChar(2000), error.slice(0, 2000))
  })
}

export async function activeMeetings(): Promise<MeetingRow[]> {
  const result = await query(workerContext, `
    SELECT id, user_oid, local_id, title, status, tracks, language, error
    FROM notes.meetings WHERE status IN (N'uploaded', N'transcribing', N'summarizing')`, () => {})
  return result.recordset as MeetingRow[]
}

export async function findByBlob(blobName: string): Promise<MeetingRow | undefined> {
  const result = await query(workerContext, `
    SELECT id, user_oid, local_id, title, status, tracks, language, error
    FROM notes.meetings WHERE tracks LIKE @like AND status <> N'failed'`, (request) => {
    request.input('like', sql.NVarChar(400), `%${blobName.replace(/[%_]/g, '')}%`)
  })
  const rows = result.recordset as MeetingRow[]
  return rows.find((row) => tracksOf(row.tracks).some((track) => track.blobName === blobName))
}

export async function storeResult(row: MeetingRow, segments: CloudSegment[], summary: { markdown: string; model: string; actionItems: ActionItem[] }, language: string | null): Promise<void> {
  const db = await getPool()
  const transaction = new sql.Transaction(db)
  await transaction.begin()
  try {
    const request = new sql.Request(transaction)
    request.input('id', sql.UniqueIdentifier, row.id)
    request.input('oid', sql.NVarChar(64), row.user_oid)
    request.input('segments', sql.NVarChar(sql.MAX), JSON.stringify(segments))
    request.input('markdown', sql.NVarChar(sql.MAX), summary.markdown)
    request.input('model', sql.NVarChar(64), summary.model)
    request.input('language', sql.NVarChar(32), language)
    await request.query(`
      EXEC sp_set_session_context @key = N'user_oid', @value = NULL;
      EXEC sp_set_session_context @key = N'bypass', @value = N'worker';
      MERGE notes.transcripts AS t
      USING (SELECT @id AS meeting_id) AS s ON t.meeting_id = s.meeting_id
      WHEN MATCHED THEN UPDATE SET content = @segments, user_oid = @oid
      WHEN NOT MATCHED THEN INSERT (meeting_id, user_oid, content) VALUES (@id, @oid, @segments);
      MERGE notes.summaries AS t
      USING (SELECT @id AS meeting_id) AS s ON t.meeting_id = s.meeting_id
      WHEN MATCHED THEN UPDATE SET markdown = @markdown, model = @model, user_oid = @oid, created_at = SYSUTCDATETIME()
      WHEN NOT MATCHED THEN INSERT (meeting_id, user_oid, model, markdown) VALUES (@id, @oid, @model, @markdown);
      DELETE FROM notes.action_items WHERE meeting_id = @id;
      UPDATE notes.meetings SET status = N'ready', language = @language, error = NULL, updated_at = SYSUTCDATETIME()
      WHERE id = @id AND user_oid = @oid;
    `)
    for (const item of summary.actionItems) {
      const action = new sql.Request(transaction)
      await action.input('id', sql.UniqueIdentifier, randomUUID())
        .input('meeting', sql.UniqueIdentifier, row.id)
        .input('oid', sql.NVarChar(64), row.user_oid)
        .input('owner', sql.NVarChar(200), item.owner)
        .input('text', sql.NVarChar(2000), item.text)
        .input('due', sql.NVarChar(200), item.due)
        .query(`
          EXEC sp_set_session_context @key = N'bypass', @value = N'worker';
          INSERT INTO notes.action_items (id, meeting_id, user_oid, owner, text, due) VALUES (@id, @meeting, @oid, @owner, @text, @due)
        `)
    }
    await transaction.commit()
  } catch (error) {
    await transaction.rollback()
    throw error
  }
}

export async function readResult(oid: string, id: string): Promise<{ segments: CloudSegment[]; summary: { markdown: string; model: string; actionItems: ActionItem[] } | null }> {
  const result = await query(userContext, `
    SELECT t.content AS transcript, s.markdown, s.model,
      (SELECT owner, text, due FROM notes.action_items a WHERE a.meeting_id = @id AND a.user_oid = @oid FOR JSON PATH) AS actions
    FROM notes.meetings m
    LEFT JOIN notes.transcripts t ON t.meeting_id = m.id AND t.user_oid = @oid
    LEFT JOIN notes.summaries s ON s.meeting_id = m.id AND s.user_oid = @oid
    WHERE m.id = @id AND m.user_oid = @oid`, (request) => {
    request.input('oid', sql.NVarChar(64), oid)
    request.input('id', sql.UniqueIdentifier, id)
  })
  const row = result.recordset[0] as { transcript?: string; markdown?: string; model?: string; actions?: string } | undefined
  const segments = row?.transcript ? JSON.parse(row.transcript) as CloudSegment[] : []
  if (!row?.markdown || !row.model) return { segments, summary: null }
  const actions = row.actions ? JSON.parse(row.actions) as ActionItem[] : []
  return { segments, summary: { markdown: row.markdown, model: row.model, actionItems: actions } }
}
