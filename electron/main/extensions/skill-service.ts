import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  parseOmpSkillListJson,
  parseSkillFrontmatter,
  type EngineSkillEntry,
  type EngineSkillSnapshot,
  type ExtensionEngine,
} from '@shared/extensions'
import type { HarnessDiscoveryService } from '../discovery'
import { runEngineCli } from './engine-cli'

const MAX_SKILL_PREVIEW_BYTES = 256 * 1024
const MAX_SCAN_DEPTH = 4
const MAX_ANCESTOR_LEVELS = 8

/** 递归收集目录下所有 SKILL.md（Agent Skills 规范：目录可任意嵌套）。 */
function collectSkillFiles(root: string, depth = 0, out: string[] = []): string[] {
  if (depth > MAX_SCAN_DEPTH) return out
  let entries
  try {
    if (!existsSync(root)) return out
    entries = readdirSync(root, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    const full = join(root, entry.name)
    try {
      if (entry.isDirectory()) {
        // 跳过明显的依赖/缓存目录
        if (entry.name === 'node_modules' || entry.name === '.git') continue
        collectSkillFiles(full, depth + 1, out)
      } else if (entry.isFile() && entry.name === 'SKILL.md') {
        out.push(full)
      }
    } catch {
      // 不可读的子目录跳过
    }
  }
  return out
}

function scanSkillDir(dir: string, engine: ExtensionEngine, origin: EngineSkillEntry['origin'], originLabel: string, out: EngineSkillEntry[]): void {
  for (const skillMd of collectSkillFiles(dir)) {
    try {
      if (!statSync(skillMd).isFile()) continue
      const content = readFileSync(skillMd, 'utf8')
      const meta = parseSkillFrontmatter(content)
      const dirName = dirname(skillMd)
      out.push({
        engine,
        name: meta.name?.trim() || dirName.split(/[\\/]/).pop() || skillMd,
        description: meta.description,
        filePath: skillMd,
        origin,
        originLabel,
        executable: origin !== 'instruction',
      })
    } catch {
      // 不可读的技能目录跳过
    }
  }
}

/**
 * 从工作目录沿祖先向上找 `.agents/skills`（Agent Skills 规范：项目级可位于
 * 任意祖先目录，找到仓库根——含 `.git` 的目录——即停）。
 */
function scanAncestorAgentSkills(project: string, engine: ExtensionEngine, out: EngineSkillEntry[]): void {
  let dir = project
  for (let level = 0; dir && level < MAX_ANCESTOR_LEVELS; level += 1) {
    scanSkillDir(join(dir, '.agents', 'skills'), engine, 'project', '.agents/skills（项目祖先目录，通用规范）', out)
    if (existsSync(join(dir, '.git'))) break
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
}

/**
 * 技能目录发现：
 * - Pi：引擎 skills 目录、用户级 `~/.agents/skills`（通用规范）、项目 `.pi/skills`、
 *   项目及祖先目录的 `.agents/skills`；包内技能由 Pi 在启动时合并发现。
 *   强制调用形式为 `/skill:名称`。
 * - OMP：`omp skill list --json`（含 claude:user 等跨引擎来源）
 * - Prime：用户级技能目录 + 项目技能目录 + 项目 Markdown 指令（AGENTS.md / CLAUDE.md）
 */
export class EngineSkillService {
  /** readSkillFile 的白名单：最近一次发现返回的文件路径。 */
  private readonly allowedPreviewPaths = new Set<string>()

  constructor(private readonly discovery: HarnessDiscoveryService) {}

  async getSnapshot(engine: ExtensionEngine, projectPath?: string | null): Promise<EngineSkillSnapshot> {
    const status = this.discovery.snapshot()[engine]
    const errors: string[] = []
    const project = projectPath && existsSync(projectPath) ? projectPath : null
    const skills: EngineSkillEntry[] = []
    let note: string | undefined

    if (engine === 'omp') {
      try {
        const res = await runEngineCli('omp', this.discovery, ['skill', 'list', '--json'], { cwd: project ?? undefined, timeoutMs: 30_000 })
        const parsed = parseOmpSkillListJson(res.combined || res.stdout)
        skills.push(...parsed.skills)
        errors.push(...parsed.errors)
        if (!res.ok) errors.push(`omp skill list 退出码 ${res.code}`)
      } catch (err) {
        errors.push(err instanceof Error ? err.message : String(err))
      }
      note = '技能在会话启动时加载；同名技能按 OMP 的来源优先级采用一份。'
    } else if (engine === 'pi') {
      scanSkillDir(join(status.agentDir, 'skills'), 'pi', 'user', 'Pi 用户级技能目录', skills)
      scanSkillDir(join(this.homeDir(), '.agents', 'skills'), 'pi', 'user', '.agents/skills（用户级，通用规范）', skills)
      if (project) {
        scanSkillDir(join(project, '.pi', 'skills'), 'pi', 'project', 'Pi 项目级 .pi/skills', skills)
        scanAncestorAgentSkills(project, 'pi', skills)
      }
      note = '发现自引擎 skills 目录、.agents/skills（用户级与项目祖先目录）与项目 .pi/skills；Pi 包内技能由引擎启动时合并。'
        + '技能在会话启动时加载，强制调用形式为 /skill:名称；项目级技能需 Pi 信任该项目。'
    } else {
      scanSkillDir(join(status.agentDir, 'skills'), 'prime', 'user', 'Prime 用户级技能目录', skills)
      if (project) {
        scanSkillDir(join(project, '.prime', 'skills'), 'prime', 'project', 'Prime 项目级 .prime/skills', skills)
        for (const [file, label] of [
          ['AGENTS.md', '项目 Markdown 指令 (AGENTS.md)'],
          ['CLAUDE.md', '项目 Markdown 指令 (CLAUDE.md)'],
        ] as const) {
          const path = join(project, file)
          try {
            if (existsSync(path) && statSync(path).isFile()) {
              skills.push({
                engine: 'prime',
                name: file,
                description: label,
                filePath: path,
                origin: 'instruction',
                originLabel: label,
                executable: false,
              })
            }
          } catch { /* ignore */ }
        }
      }
      note = '区分项目 Markdown 指令与用户级技能目录；可执行技能（含 Python 技能）由包管理器安装。'
    }

    const seen = new Set<string>()
    const deduped = skills.filter((skill) => {
      const key = `${skill.engine}|${skill.name}|${skill.filePath}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    for (const skill of deduped) this.allowedPreviewPaths.add(skill.filePath)

    return {
      engine,
      engineReady: status.ready,
      engineVersion: status.version,
      projectPath: project,
      skills: deduped,
      note,
      errors,
      fetchedAt: Date.now(),
    }
  }

  /** 只允许预览最近一次技能发现返回的文件，防止任意路径读取。 */
  readSkillFile(filePath: string): { path: string; content: string; truncated: boolean } {
    if (typeof filePath !== 'string' || !this.allowedPreviewPaths.has(filePath)) {
      throw new Error('该文件不在技能发现结果中，无法预览')
    }
    const stat = statSync(filePath)
    const content = readFileSync(filePath, 'utf8')
    const truncated = stat.size > MAX_SKILL_PREVIEW_BYTES
    return {
      path: filePath,
      content: truncated ? content.slice(0, MAX_SKILL_PREVIEW_BYTES) : content,
      truncated,
    }
  }

  private homeDir(): string {
    return process.env.USERPROFILE || process.env.HOME || ''
  }
}
