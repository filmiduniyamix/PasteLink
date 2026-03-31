export async function onRequestPost(context) {
    const { env } = context;
    const { title, content, privacy, password } = await context.request.json();
    
    const id = Math.random().toString(36).substring(2, 9);
    const editKey = Math.random().toString(36).substring(2, 15);

    const pasteData = {
        title: title || "Untitled",
        content,
        privacy,
        password: password || null,
        editKey,
        createdAt: Date.now()
    };

    await env.PASTES.put(id, JSON.stringify(pasteData));

    return new Response(JSON.stringify({ success: true, id, c22e75e9285a458ca1b8e17f60620e3a }), {
        headers: { 'Content-Type': 'application/json' }
    });
}
