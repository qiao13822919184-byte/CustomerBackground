import type { MaterialInput } from '../shared/types';

const LIMIT = 6 * 1024 * 1024;
function dataUrl(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(new Error('图片读取失败')); reader.readAsDataURL(file); });
}
export async function readMaterials(files: File[]): Promise<MaterialInput[]> {
  if (files.length > 15) throw new Error('每次最多上传 15 个文件，请分批补充资料。');
  const output: MaterialInput[] = [];
  let totalText = 0;
  for (const file of files) {
    if (file.size > LIMIT) throw new Error(`${file.name} 超过单文件 6 MB 限制，请拆分后上传。`);
    const extension = file.name.split('.').pop()?.toLowerCase();
    const item: MaterialInput = { filename: file.name, mime_type: file.type || 'application/octet-stream' };
    if (['jpg', 'jpeg', 'png', 'webp'].includes(extension || '')) {
      item.data_url = await dataUrl(file);
    } else if (['md', 'txt', 'csv', 'tsv', 'json'].includes(extension || '')) {
      item.text = await file.text();
    } else if (['xlsx', 'xls'].includes(extension || '')) {
      const XLSX = await import('xlsx');
      const book = XLSX.read(await file.arrayBuffer(), { type: 'array' });
      item.text = book.SheetNames.map(name => `工作表：${name}\n${XLSX.utils.sheet_to_csv(book.Sheets[name])}`).join('\n\n');
    } else if (extension === 'docx') {
      const mammoth = await import('mammoth');
      const result = await mammoth.extractRawText({ arrayBuffer: await file.arrayBuffer() });
      item.text = result.value;
      item.warnings = result.messages.map(message => message.message);
    } else if (extension === 'pdf') {
      const pdfjs = await import('pdfjs-dist');
      const worker = await import('pdfjs-dist/build/pdf.worker.min.mjs?url');
      pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
      const loadingTask = pdfjs.getDocument({ data: await file.arrayBuffer() });
      const doc = await loadingTask.promise;
      try {
        if (doc.numPages > 120) throw new Error(`${file.name} 超过 120 页，请按章节拆分。`);
        const pages: string[] = [];
        for (let number = 1; number <= doc.numPages; number++) {
          const page = await doc.getPage(number);
          const content = await page.getTextContent();
          pages.push(`第 ${number} 页\n${content.items.map(value => 'str' in value ? value.str + (value.hasEOL ? '\n' : ' ') : '').join('')}`);
        }
        item.text = pages.join('\n\n');
        if (item.text.replace(/第 \d+ 页/g, '').trim().length < 40) {
          throw new Error(`${file.name} 未提取到可用文字。请将关键扫描页面另存为 JPG/PNG 后上传，避免漏读产品信息。`);
        }
        item.warnings = ['PDF 当前提取文字；图表、扫描文字和图片中的参数请同时上传关键页图片。'];
      } finally { await loadingTask.destroy(); }
    } else {
      throw new Error(`暂不支持 ${file.name}。请使用 MD、TXT、CSV、XLSX、DOCX、PDF、JPG 或 PNG。`);
    }
    totalText += item.text?.length || 0;
    if (totalText > 800000) throw new Error('本批文字量过大，请分批上传，避免上下文遗漏。');
    output.push(item);
  }
  if (JSON.stringify(output).length > 9 * 1024 * 1024) throw new Error('本批资料超过上传容量，请分批上传。');
  return output;
}
