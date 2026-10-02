import { createServer } from 'node:http';
const prefix = 'file:///E:/Xiadie/Xiadie/.runtime/P01/desktop-source/node_modules/';
const { generateText } = await import(prefix + 'ai/dist/index.mjs');
const { createOpenAICompatible } = await import(prefix + '@ai-sdk/openai-compatible/dist/index.mjs');
const server = createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  console.log(JSON.stringify({method:req.method, path:req.url, keys:Object.keys(body).sort(), stream_present:Object.hasOwn(body,'stream'), tools_present:Object.hasOwn(body,'tools'), tool_choice_present:Object.hasOwn(body,'tool_choice'), stream_value:body.stream, tools_value:body.tools, tool_choice_value:body.tool_choice}));
  res.writeHead(200, {'content-type':'application/json'});
  res.end(JSON.stringify({id:'local-title-shape',object:'chat.completion',created:1,model:'deepseek-flash',choices:[{index:0,message:{role:'assistant',content:'{"title":"local title"}'},finish_reason:'stop'}],usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2}}));
});
await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
const port = server.address().port;
try {
  const provider = createOpenAICompatible({name:'p01-u10-local-shape',baseURL:`http://127.0.0.1:${port}/v1`,apiKey:'p01-u09-loopback-only'});
  await generateText({model:provider.chatModel('deepseek-flash'),system:'Generate a short title.',prompt:'Local test prompt.',maxOutputTokens:1024,tools:[]});
} finally { await new Promise(resolve => server.close(resolve)); }