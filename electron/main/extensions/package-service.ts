import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  EXTENSION_ENGINE_CAPABILITIES,
  parseOmpPluginListJson,
  parsePlainPackageList,
  type EnginePackageEntry,
  type EnginePackageSnapshot,
  type ExtensionEngine,
} from '@shared/extensions'
import type { HarnessDiscoveryService } from '../discovery'
import { runEngineCli, firstJsonPayload } from './engine-cli'

function packageOperationCwd(engine: ExtensionEngine, scope: 'user' | 'project', projectPath?: string | null): string | undefined {
  if (scope === 'user') return undefined
  if (!EXTENSION_ENGINE_CAPABILITIES[engine].packages.projectScope) {
    throw new Error('该引擎仅支持用户级插件操作')
  }
  if (!projectPath || !existsSync(projectPath)) throw new Error('项目级插件操作需要先选择一个有效项目')
  return projectPath
}

/**
 * 插件 / 包管理：三个引擎的原生包管理器。
 * - Pi：`pi install/remove/update/list`（用户级或项目级 settings）
 * - OMP：`omp plugin list/install/uninstall/enable/disable/upgrade`
 * - Prime：`prime-agent package install/remove/update/list`
 */
export class EnginePackageService {
  constructor(private readonly discovery: HarnessDiscoveryService) {}

  async getSnapshot(engine: ExtensionEngine, projectPath?: string | null): Promise<EnginePackageSnapshot> {
    const status = this.discovery.snapshot()[engine]
    const errors: string[] = []
    const project = projectPath && existsSync(projectPath) ? projectPath : null
    let packages: EnginePackageEntry[] = []
    let raw: string | undefined

    if (engine === 'omp') {
      try {
        const res = await runEngineCli('omp', this.discovery, ['plugin', 'list', '--json'], { cwd: project ?? undefined, timeoutMs: 30_000 })
        const payload = firstJsonPayload(res.combined || res.stdout) ?? res.stdout
        const parsed = parseOmpPluginListJson(payload)
        packages = parsed.packages
        errors.push(...parsed.errors)
        if (!res.ok) errors.push(`omp plugin list 退出码 ${res.code}`)
      } catch (err) {
        errors.push(err instanceof Error ? err.message : String(err))
      }
    } else if (engine === 'pi') {
      const res = await runEngineCli('pi', this.discovery, ['list'], { cwd: project ?? undefined, timeoutMs: 20_000 }).catch((err) => null)
      if (res) {
        packages = parsePlainPackageList(res.combined || res.stdout, 'pi')
        if (!res.ok) errors.push(`pi list 退出码 ${res.code}`)
        if (packages.length === 0 && !res.ok) raw = res.combined
        // 项目级包来源标注：.pi/settings.json 中出现同名条目时标记 project
        if (project) packages = this.tagPiProjectPackages(packages, project)
      } else {
        errors.push('pi list 执行失败')
      }
    } else {
      const res = await runEngineCli('prime', this.discovery, ['package', 'list'], { cwd: project ?? undefined, timeoutMs: 20_000 }).catch(() => null)
      if (res) {
        packages = parsePlainPackageList(res.combined || res.stdout, 'prime')
        if (!res.ok) errors.push(`prime-agent package list 退出码 ${res.code}`)
        if (packages.length === 0 && !res.ok) raw = res.combined
      } else {
        errors.push('prime-agent package list 执行失败')
      }
    }

    return {
      engine,
      engineReady: status.ready,
      engineVersion: status.version,
      projectPath: project,
      packages,
      errors,
      ...(raw !== undefined ? { raw } : {}),
      fetchedAt: Date.now(),
    }
  }

  /** Pi 项目包：对比项目 .pi/settings.json（packages 数组或 packages[source]=true 形式）。 */
  private tagPiProjectPackages(packages: EnginePackageEntry[], project: string): EnginePackageEntry[] {
    let projectNames: Set<string> | null = null
    for (const rel of [join(project, '.pi', 'settings.json'), join(project, '.pi', 'settings.local.json')]) {
      try {
        if (!existsSync(rel)) continue
        const parsed = JSON.parse(readFileSync(rel, 'utf8')) as Record<string, unknown>
        const packagesKey = parsed.packages
        const names = new Set<string>()
        if (Array.isArray(packagesKey)) {
          for (const item of packagesKey) {
            if (typeof item === 'string') names.add(item)
            else if (item && typeof item === 'object') {
              const rec = item as Record<string, unknown>
              if (typeof rec.source === 'string') names.add(rec.source)
            }
          }
        } else if (packagesKey && typeof packagesKey === 'object') {
          for (const [key, value] of Object.entries(packagesKey as Record<string, unknown>)) {
            if (value !== false) names.add(key)
          }
        }
        if (names.size > 0) {
          if (projectNames === null) projectNames = new Set()
          for (const name of names) projectNames.add(name)
        }
      } catch { /* 坏 JSON 忽略 */ }
    }
    if (!projectNames) return packages
    const names = projectNames
    return packages.map((pkg) => (names.has(pkg.id) || names.has(pkg.name)
      ? { ...pkg, scope: 'project' as const }
      : pkg))
  }

  async install(engine: ExtensionEngine, source: string, scope: 'user' | 'project', projectPath?: string | null): Promise<EnginePackageSnapshot> {
    const trimmed = source.trim()
    if (!trimmed || trimmed.length > 300) throw new Error('请输入有效的包来源（如 npm:@scope/pkg、git:github.com/user/repo 或本地路径）')
    if (/[\r\n]/.test(trimmed)) throw new Error('包来源不能包含换行')
    const cwd = packageOperationCwd(engine, scope, projectPath)
    let res
    if (engine === 'omp') {
      const args = scope === 'project'
        ? ['plugin', 'install', trimmed, '--scope=project']
        : ['plugin', 'install', trimmed]
      res = await runEngineCli('omp', this.discovery, args, { cwd, timeoutMs: 180_000, maxBytes: 8 * 1024 * 1024 })
    } else if (engine === 'pi') {
      const args = scope === 'project' ? ['install', trimmed, '-l'] : ['install', trimmed]
      res = await runEngineCli('pi', this.discovery, args, { cwd, timeoutMs: 180_000, maxBytes: 8 * 1024 * 1024 })
    } else {
      res = await runEngineCli('prime', this.discovery, ['package', 'install', trimmed], { timeoutMs: 180_000, maxBytes: 8 * 1024 * 1024 })
    }
    if (!res.ok) {
      throw new Error(`安装失败（退出码 ${res.code}${res.timedOut ? '，超时' : ''}）: ${res.combined.slice(-600)}`)
    }
    return this.getSnapshot(engine, projectPath)
  }

  async remove(engine: ExtensionEngine, name: string, scope: 'user' | 'project', projectPath?: string | null): Promise<EnginePackageSnapshot> {
    const trimmed = name.trim()
    if (!trimmed || /[\r\n]/.test(trimmed)) throw new Error('无效的包名称')
    const cwd = packageOperationCwd(engine, scope, projectPath)
    let res
    if (engine === 'omp') {
      const args = scope === 'project'
        ? ['plugin', 'uninstall', trimmed, '--scope=project']
        : ['plugin', 'uninstall', trimmed]
      res = await runEngineCli('omp', this.discovery, args, { cwd, timeoutMs: 60_000 })
    } else if (engine === 'pi') {
      const args = scope === 'project' ? ['remove', trimmed, '-l'] : ['remove', trimmed]
      res = await runEngineCli('pi', this.discovery, args, { cwd, timeoutMs: 60_000 })
    } else {
      res = await runEngineCli('prime', this.discovery, ['package', 'remove', trimmed], { timeoutMs: 60_000 })
    }
    if (!res.ok) {
      throw new Error(`卸载失败（退出码 ${res.code}）: ${res.combined.slice(-600)}`)
    }
    return this.getSnapshot(engine, projectPath)
  }

  async update(engine: ExtensionEngine, name: string | null, scope: 'user' | 'project', projectPath?: string | null): Promise<EnginePackageSnapshot> {
    const target = name?.trim()
    if (target && /[\r\n]/.test(target)) throw new Error('无效的包名称')
    const cwd = packageOperationCwd(engine, scope, projectPath)
    let res
    if (engine === 'omp') {
      const args = target ? ['plugin', 'upgrade', target] : ['plugin', 'upgrade']
      res = await runEngineCli('omp', this.discovery, scope === 'project' ? [...args, '--scope=project'] : args, { cwd, timeoutMs: 300_000, maxBytes: 8 * 1024 * 1024 })
    } else if (engine === 'pi') {
      res = await runEngineCli('pi', this.discovery, target ? ['update', target] : ['update'], { cwd, timeoutMs: 300_000, maxBytes: 8 * 1024 * 1024 })
    } else {
      res = await runEngineCli('prime', this.discovery, target ? ['package', 'update', target] : ['package', 'update'], { timeoutMs: 300_000, maxBytes: 8 * 1024 * 1024 })
    }
    if (!res.ok) {
      throw new Error(`更新失败（退出码 ${res.code}）: ${res.combined.slice(-600)}`)
    }
    return this.getSnapshot(engine, projectPath)
  }
}
