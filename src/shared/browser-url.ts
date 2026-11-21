/** 地址栏输入规范化：无协议时自动补全，浏览器窗口与测试共用。 */
export function normalizeUrlInput(raw: string): string {
  const value = raw.trim()
  if (!value) return ''
  if (/^https?:\/\//i.test(value)) return value
  if (/^about:blank$/i.test(value)) return 'about:blank'
  if (/^[\w-]+(\.[\w-]+)+(:\d+)?(\/.*)?$/.test(value)) return `https://${value}`
  if (/^localhost(:\d+)?(\/.*)?$/i.test(value)) return `http://${value}`
  return value
}
