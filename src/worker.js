// Pastebin Worker – Cloudflare Workers + D1 + KV

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    // CORS headers for frontend (allow your Pages domain)
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*', // change to your domain in production
      'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    // Helper: hash edit code
    async function hashCode(code) {
      const encoder = new TextEncoder();
      const data = encoder.encode(code);
      const hash = await crypto.subtle.digest('SHA-256', data);
      return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
    }

    // Helper: generate random ID (nanoid style)
    function generateId() {
      return crypto.randomUUID().replace(/-/g, '').slice(0, 12);
    }

    // 1. Create paste
    if (path === '/api/pastes' && request.method === 'POST') {
      try {
        const { content, privacy, editCode, title } = await request.json();
        if (!content || !privacy || !editCode) {
          return new Response(JSON.stringify({ error: 'Missing fields' }), { status: 400, headers: corsHeaders });
        }
        const id = generateId();
        const now = Date.now();
        const editCodeHash = await hashCode(editCode);

        // Store main paste metadata in D1
        await env.PASTE_DB.prepare(
          `INSERT INTO pastes (id, title, privacy, edit_code_hash, created_at, updated_at, current_version)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        ).bind(id, title || null, privacy, editCodeHash, now, now, 1).run();

        // Store version 1 in KV (for fast access)
        const versionData = { content, createdAt: now };
        await env.PASTE_KV.put(`paste:${id}:v1`, JSON.stringify(versionData));

        // Also store current version pointer in KV (optional)
        await env.PASTE_KV.put(`paste:${id}:current`, JSON.stringify({ version: 1, content, updatedAt: now }));

        return new Response(JSON.stringify({ id, editCode }), { headers: corsHeaders });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: corsHeaders });
      }
    }

    // 2. Get paste (view)
    if (path.startsWith('/api/pastes/') && request.method === 'GET') {
      const id = path.split('/')[3];
      const urlParams = url.searchParams;
      const providedEditCode = urlParams.get('editCode');
      const view = urlParams.get('view') === 'history' ? 'history' : 'paste';

      // Fetch paste metadata from D1
      const paste = await env.PASTE_DB.prepare('SELECT * FROM pastes WHERE id = ?').bind(id).first();
      if (!paste) {
        return new Response(JSON.stringify({ error: 'Not found' }), { status: 404, headers: corsHeaders });
      }

      // Privacy check: if private, require edit code to view
      if (paste.privacy === 'private') {
        if (!providedEditCode) {
          return new Response(JSON.stringify({ error: 'Edit code required for private paste' }), { status: 401, headers: corsHeaders });
        }
        const hash = await hashCode(providedEditCode);
        if (hash !== paste.edit_code_hash) {
          return new Response(JSON.stringify({ error: 'Invalid edit code' }), { status: 403, headers: corsHeaders });
        }
      }

      // If history requested
      if (view === 'history') {
        const versions = await env.PASTE_DB.prepare(
          'SELECT version, created_at FROM versions WHERE paste_id = ? ORDER BY version DESC'
        ).bind(id).all();
        // Also get current version
        const currentVersion = { version: paste.current_version, created_at: paste.updated_at };
        const allVersions = [currentVersion, ...versions.results];
        // For each version, fetch content from KV
        const history = [];
        for (const v of allVersions) {
          const kvKey = `paste:${id}:v${v.version}`;
          const data = await env.PASTE_KV.get(kvKey, 'json');
          if (data) {
            history.push({ version: v.version, content: data.content, createdAt: v.created_at });
          }
        }
        return new Response(JSON.stringify({ id, history }), { headers: corsHeaders });
      } else {
        // Normal view: get current version content from KV
        const kvKey = `paste:${id}:v${paste.current_version}`;
        const data = await env.PASTE_KV.get(kvKey, 'json');
        if (!data) {
          return new Response(JSON.stringify({ error: 'Content missing' }), { status: 500, headers: corsHeaders });
        }
        return new Response(JSON.stringify({
          id: paste.id,
          title: paste.title,
          content: data.content,
          privacy: paste.privacy,
          createdAt: paste.created_at,
          updatedAt: paste.updated_at,
          currentVersion: paste.current_version
        }), { headers: corsHeaders });
      }
    }

    // 3. Edit paste (update)
    if (path.startsWith('/api/pastes/') && request.method === 'PUT') {
      const id = path.split('/')[3];
      const { content, editCode, newEditCode } = await request.json();
      if (!content || !editCode) {
        return new Response(JSON.stringify({ error: 'Missing content or editCode' }), { status: 400, headers: corsHeaders });
      }

      // Get paste metadata
      const paste = await env.PASTE_DB.prepare('SELECT * FROM pastes WHERE id = ?').bind(id).first();
      if (!paste) {
        return new Response(JSON.stringify({ error: 'Not found' }), { status: 404, headers: corsHeaders });
      }

      // Verify edit code
      const providedHash = await hashCode(editCode);
      if (providedHash !== paste.edit_code_hash) {
        return new Response(JSON.stringify({ error: 'Invalid edit code' }), { status: 403, headers: corsHeaders });
      }

      const now = Date.now();
      const newVersion = paste.current_version + 1;

      // Store current content as version in KV (for history)
      const currentKV = await env.PASTE_KV.get(`paste:${id}:v${paste.current_version}`, 'json');
      if (currentKV) {
        // Insert into versions table in D1
        await env.PASTE_DB.prepare(
          'INSERT INTO versions (paste_id, version, content, created_at) VALUES (?, ?, ?, ?)'
        ).bind(id, paste.current_version, currentKV.content, paste.updated_at).run();
      }

      // Save new version content in KV
      await env.PASTE_KV.put(`paste:${id}:v${newVersion}`, JSON.stringify({ content, createdAt: now }));

      // Update D1: current_version, updated_at, and optionally edit_code_hash if newEditCode provided
      let query = `UPDATE pastes SET current_version = ?, updated_at = ?`;
      const params = [newVersion, now];
      if (newEditCode) {
        const newHash = await hashCode(newEditCode);
        query += `, edit_code_hash = ?`;
        params.push(newHash);
      }
      query += ` WHERE id = ?`;
      params.push(id);
      await env.PASTE_DB.prepare(query).bind(...params).run();

      // Update current KV pointer
      await env.PASTE_KV.put(`paste:${id}:current`, JSON.stringify({ version: newVersion, content, updatedAt: now }));

      return new Response(JSON.stringify({ success: true, version: newVersion }), { headers: corsHeaders });
    }

    // 4. List public pastes
    if (path === '/api/pastes' && request.method === 'GET') {
      const page = parseInt(url.searchParams.get('page') || '1');
      const limit = 20;
      const offset = (page - 1) * limit;
      const pastes = await env.PASTE_DB.prepare(
        `SELECT id, title, created_at FROM pastes WHERE privacy = 'public' ORDER BY created_at DESC LIMIT ? OFFSET ?`
      ).bind(limit, offset).all();
      return new Response(JSON.stringify({ pastes: pastes.results, page }), { headers: corsHeaders });
    }

    return new Response('Not found', { status: 404, headers: corsHeaders });
  }
};
