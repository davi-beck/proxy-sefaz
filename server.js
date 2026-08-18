const http = require('http');
const https = require('https');
const { URL } = require('url');
const zlib = require('zlib');

const PORT = process.env.PORT || 3000;
const WS_URL = 'https://www1.nfe.fazenda.gov.br/NFeDistribuicaoDFe/NFeDistribuicaoDFe.asmx';
const SOAP_ACTION = 'http://www.portalfiscal.inf.br/nfe/wsdl/NFeDistribuicaoDFe/nfeDistDFeInteresse';
const CNPJ_BASE = process.env.SEFAZ_CNPJ_BASE || '26478473000192';

function buildSoapEnvelope(chave) {
  const uf = chave.slice(0, 2);
  const cnpj = CNPJ_BASE;
  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<soap12:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:soap12="http://www.w3.org/2003/05/soap-envelope">',
    '<soap12:Body>',
    '<nfeDistDFeInteresse xmlns="http://www.portalfiscal.inf.br/nfe/wsdl/NFeDistribuicaoDFe">',
    '<nfeDadosMsg>',
    '<distDFeInt xmlns="http://www.portalfiscal.inf.br/nfe" versao="1.01">',
    '<tpAmb>1</tpAmb>',
    '<cUFAutor>' + uf + '</cUFAutor>',
    '<CNPJ>' + cnpj + '</CNPJ>',
    '<consChNFe><chNFe>' + chave + '</chNFe></consChNFe>',
    '</distDFeInt>',
    '</nfeDadosMsg>',
    '</nfeDistDFeInteresse>',
    '</soap12:Body>',
    '</soap12:Envelope>',
  ].join('');
}

function buildSoapEnvelopeNSU(ultNSU) {
  const uf = '35';
  const cnpj = CNPJ_BASE;
  const nsuFormatado = String(ultNSU).padStart(15, '0');
  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<soap12:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:soap12="http://www.w3.org/2003/05/soap-envelope">',
    '<soap12:Body>',
    '<nfeDistDFeInteresse xmlns="http://www.portalfiscal.inf.br/nfe/wsdl/NFeDistribuicaoDFe">',
    '<nfeDadosMsg>',
    '<distDFeInt xmlns="http://www.portalfiscal.inf.br/nfe" versao="1.01">',
    '<tpAmb>1</tpAmb>',
    '<cUFAutor>' + uf + '</cUFAutor>',
    '<CNPJ>' + cnpj + '</CNPJ>',
    '<distNSU><ultNSU>' + nsuFormatado + '</ultNSU></distNSU>',
    '</distDFeInt>',
    '</nfeDadosMsg>',
    '</nfeDistDFeInteresse>',
    '</soap12:Body>',
    '</soap12:Envelope>',
  ].join('');
}

function extractField(xml, tag) {
  const m = xml.match(new RegExp('<' + tag + '>([^<]*)</' + tag + '>'));
  return m ? m[1] : '';
}

function parseSefazResponse(xmlBody) {
  const cStat = extractField(xmlBody, 'cStat');
  const xMotivo = extractField(xmlBody, 'xMotivo');
  if (cStat && cStat !== '138') {
    return { ok: false, code: 'SEFAZ_REJEICAO', cStat, message: xMotivo || 'Rejeição não especificada' };
  }
  let nfXml = '';
  const docZipMatch = xmlBody.match(/<docZip[^>]*>([^<]*)<\/docZip>/);
  if (docZipMatch) {
    try { nfXml = zlib.gunzipSync(Buffer.from(docZipMatch[1], 'base64')).toString('utf8'); } catch (e) { console.error('gunzip:', e.message); }
  }
  if (!nfXml) {
    const m = xmlBody.match(/<resNFe[^>]*>([\s\S]*?)<\/resNFe>/);
    if (m) nfXml = m[1]; else nfXml = xmlBody;
  }
  return {
    ok: true, cStat,
    cnpjEmitente: extractField(nfXml, 'CNPJ') || extractField(xmlBody, 'CNPJ'),
    razaoSocial: extractField(nfXml, 'xNome') || extractField(xmlBody, 'xNome'),
    valor: extractField(nfXml, 'vNF') || extractField(xmlBody, 'vNF'),
    dataEmissao: extractField(nfXml, 'dhEmi') || extractField(nfXml, 'dEmi') || extractField(xmlBody, 'dhEmi'),
    numero: extractField(nfXml, 'nNF') || extractField(xmlBody, 'nNF'),
    serie: extractField(nfXml, 'serie') || extractField(xmlBody, 'serie'),
    modelo: extractField(nfXml, 'mod') || extractField(xmlBody, 'mod'),
    ie: extractField(nfXml, 'IE') || extractField(xmlBody, 'IE'),
    tpNF: extractField(nfXml, 'tpNF') || extractField(xmlBody, 'tpNF'),
  };
}

function parseSefazNSUResponse(xmlBody) {
  const cStat = extractField(xmlBody, 'cStat');
  const xMotivo = extractField(xmlBody, 'xMotivo');
  const ultNSU = extractField(xmlBody, 'ultNSU');
  const maxNSU = extractField(xmlBody, 'maxNSU');
  if (cStat && cStat !== '138' && cStat !== '612') {
    return { ok: false, code: 'SEFAZ_REJEICAO', cStat, message: xMotivo };
  }
  const docZipMatches = [...xmlBody.matchAll(/<docZip[^>]*NSU="(\d+)"[^>]*>([^<]*)<\/docZip>/g)];
  const nfs = [];
  for (const match of docZipMatches) {
    const nsu = match[1];
    try {
      const decompressed = zlib.gunzipSync(Buffer.from(match[2], 'base64')).toString('utf8');
      if (decompressed.includes('<resNFe') || decompressed.includes('<protNFe') || decompressed.includes('<nfeProc')) {
        nfs.push({
          nsu, chave: extractField(decompressed, 'chNFe'),
          cnpjEmitente: extractField(decompressed, 'CNPJ'),
          razaoSocial: extractField(decompressed, 'xNome'),
          valor: extractField(decompressed, 'vNF'),
          dataEmissao: extractField(decompressed, 'dhEmi') || extractField(decompressed, 'dEmi'),
          numero: extractField(decompressed, 'nNF'),
          serie: extractField(decompressed, 'serie'),
          modelo: extractField(decompressed, 'mod'),
          tpNF: extractField(decompressed, 'tpNF'),
          ie: extractField(decompressed, 'IE'),
          tipo: decompressed.includes('<resNFe') ? 'resNFe' : 'procNFe',
        });
      }
    } catch (e) { console.error('NSU ' + nsu + ':', e.message); }
  }
  return { ok: true, cStat, ultNSU, maxNSU, temMais: ultNSU && maxNSU && ultNSU !== maxNSU, count: nfs.length, nfs };
}

function sendSoap(url, soapBody, certKey, certCrt) {
  return new Promise((resolve, reject) => {
    const p = new URL(url);
    const req = https.request({
      hostname: p.hostname, port: 443, path: p.pathname, method: 'POST',
      headers: { 'Content-Type': 'application/soap+xml; charset=utf-8; action="' + SOAP_ACTION + '"', 'Content-Length': Buffer.byteLength(soapBody) },
      key: certKey, cert: certCrt, secureProtocol: 'TLSv1_2_method', rejectUnauthorized: true,
    }, (res) => { let d = ''; res.on('data', c => d += c); res.on('end', () => resolve({ statusCode: res.statusCode, body: d })); });
    req.on('error', reject);
    req.setTimeout(60000, () => req.destroy(new Error('Timeout')));
    req.write(soapBody); req.end();
  });
}

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
  const parsedUrl = new URL(req.url, 'http://localhost');
  if (parsedUrl.pathname === '/health') { res.writeHead(200, {'Content-Type':'application/json'}); res.end(JSON.stringify({ ok: true, service: 'proxy-sefaz' })); return; }
  const expectedSecret = process.env.SKIP_PROXY_SECRET;
  if (expectedSecret) {
    const authHeader = req.headers.authorization || '';
    if (authHeader.replace('Bearer ', '') !== expectedSecret) { res.writeHead(401, {'Content-Type':'application/json'}); res.end(JSON.stringify({ ok: false, code: 'UNAUTHORIZED' })); return; }
  }
  if (req.method === 'POST' && parsedUrl.pathname === '/consulta') {
    let body = ''; for await (const chunk of req) body += chunk;
    let parsed; try { parsed = JSON.parse(body); } catch { res.writeHead(400, {'Content-Type':'application/json'}); res.end(JSON.stringify({ ok: false, code: 'BAD_REQUEST' })); return; }
    const chave = String(parsed.chave || '').trim();
    if (!/^\d{44}$/.test(chave)) { res.writeHead(400, {'Content-Type':'application/json'}); res.end(JSON.stringify({ ok: false, code: 'CHAVE_INVALIDA' })); return; }
    const certKey = process.env.SEFAZ_CERT_KEY, certCrt = process.env.SEFAZ_CERT_CRT;
    if (!certKey || !certCrt) { res.writeHead(500, {'Content-Type':'application/json'}); res.end(JSON.stringify({ ok: false, code: 'CERT_NOT_CONFIGURED' })); return; }
    try {
      const resp = await sendSoap(WS_URL, buildSoapEnvelope(chave), certKey, certCrt);
      const respBody = String(resp.body || '');
      if (resp.statusCode >= 400) { res.writeHead(502, {'Content-Type':'application/json'}); res.end(JSON.stringify({ ok: false, code: 'SEFAZ_ERRO_HTTP', raw: respBody.slice(0,300) })); return; }
      const result = parseSefazResponse(respBody);
      res.writeHead(200, {'Content-Type':'application/json'});
      res.end(JSON.stringify({ ok: result.ok, code: result.code || 'OK', chave, uf: chave.slice(0,2), cnpj: chave.slice(6,20), ...result }));
    } catch (err) { console.error('Erro:', err); res.writeHead(502, {'Content-Type':'application/json'}); res.end(JSON.stringify({ ok: false, code: 'SEFAZ_ERRO_REDE', message: String(err.message||err).slice(0,200) })); }
    return;
  }
  if (req.method === 'POST' && parsedUrl.pathname === '/importar') {
    let body = ''; for await (const chunk of req) body += chunk;
    let parsed; try { parsed = JSON.parse(body); } catch { res.writeHead(400, {'Content-Type':'application/json'}); res.end(JSON.stringify({ ok: false, code: 'BAD_REQUEST' })); return; }
    const certKey = process.env.SEFAZ_CERT_KEY, certCrt = process.env.SEFAZ_CERT_CRT;
    if (!certKey || !certCrt) { res.writeHead(500, {'Content-Type':'application/json'}); res.end(JSON.stringify({ ok: false, code: 'CERT_NOT_CONFIGURED' })); return; }
    try {
      let ultNSU = parsed.ultNSU || '0';
      const todasNFs = []; let lote = 0; let maxNSU = '0'; let temMais = true;
      while (temMais && lote < 20) {
        lote++;
        console.log('Importacao lote ' + lote + ' | ultNSU=' + ultNSU);
        const resp = await sendSoap(WS_URL, buildSoapEnvelopeNSU(ultNSU), certKey, certCrt);
        const result = parseSefazNSUResponse(String(resp.body || ''));
        if (!result.ok) { res.writeHead(200, {'Content-Type':'application/json'}); res.end(JSON.stringify({ ok: false, code: 'SEFAZ_REJEICAO', cStat: result.cStat, message: result.message, importadas: todasNFs.length, nfs: todasNFs })); return; }
        if (result.nfs && result.nfs.length > 0) todasNFs.push(...result.nfs);
        ultNSU = result.ultNSU || ultNSU; maxNSU = result.maxNSU || maxNSU; temMais = result.temMais;
        if (!temMais) break;
        await new Promise(r => setTimeout(r, 500));
      }
      console.log('Importacao: ' + todasNFs.length + ' NFs em ' + lote + ' lote(s)');
      res.writeHead(200, {'Content-Type':'application/json'});
      res.end(JSON.stringify({ ok: true, total: todasNFs.length, lotes: lote, ultNSU, maxNSU, nfs: todasNFs }));
    } catch (err) { console.error('Erro importacao:', err); res.writeHead(502, {'Content-Type':'application/json'}); res.end(JSON.stringify({ ok: false, code: 'SEFAZ_ERRO_REDE', message: String(err.message||err).slice(0,200) })); }
    return;
  }
  res.writeHead(404, {'Content-Type':'application/json'}); res.end(JSON.stringify({ ok: false, code: 'NOT_FOUND' }));
});

server.listen(PORT, () => { console.log('Proxy SEFAZ rodando na porta', PORT); });