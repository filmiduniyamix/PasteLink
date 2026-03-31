export async function onRequestGet(context) {
    const { env, params } = context;
    const raw = await env.PASTES.get(params.id);

    if (!raw) return new Response("Paste Not Found", { status: 404 });
    const data = JSON.parse(raw);

    const html = `
    <!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>${data.title}</title>
        <script src="https://cdn.tailwindcss.com"></script>
    </head>
    <body class="bg-slate-900 text-slate-100 p-4 md:p-10 font-sans">
        <div class="max-w-4xl mx-auto">
            <header class="mb-6 flex justify-between items-center">
                <div>
                    <h1 class="text-3xl font-bold text-blue-400">${data.title}</h1>
                    <p class="text-slate-500 text-sm">Created: ${new Date(data.createdAt).toLocaleString()}</p>
                </div>
                <a href="/" class="bg-slate-800 px-4 py-2 rounded-lg text-sm border border-slate-700">Create New</a>
            </header>
            <div class="bg-slate-800 p-6 rounded-xl border border-slate-700 shadow-xl overflow-x-auto">
                <pre class="whitespace-pre-wrap font-mono text-sm md:text-base">${data.content.replace(/</g, "&lt;")}</pre>
            </div>
        </div>
    </body>
    </html>`;

    return new Response(html, { headers: { 'Content-Type': 'text/html' } });
}
