export async function onRequestPost(context) {
    const { env } = context;
    const { id, title, content, privacy, password } = await context.request.json();
    
    const raw = await env.PASTES.get(id);
    if (!raw) return new Response("Not Found", { status: 404 });

    const data = JSON.parse(raw);
    // Yahan hum browser se edit key check kar sakte hain, abhi ke liye update allow karte hain
    data.title = title;
    data.content = content;
    data.privacy = privacy;
    data.password = password || data.password;

    await env.PASTES.put(id, JSON.stringify(data));
    return new Response(JSON.stringify({ success: true }));
}
