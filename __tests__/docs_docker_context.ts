import { existsSync, readFileSync, readdirSync } from 'fs'
import { dirname, join, resolve, sep } from 'path'

const markdownFiles = (dir: string): string[] => readdirSync(dir, { withFileTypes: true })
  .flatMap(entry => entry.isDirectory()
    ? ['node_modules', '.vitepress', 'public'].includes(entry.name) ? [] : markdownFiles(join(dir, entry.name))
    : entry.name.endsWith('.md') ? [join(dir, entry.name)] : [])

describe('documentation Docker context', () => {
  test('copies canonical docs before validation and includes every Markdown dependency', () => {
    const dockerfile = readFileSync('docs-site/Dockerfile', 'utf8')
    expect(dockerfile).toMatch(/^COPY docs \.\/docs$/m)
    expect(dockerfile.indexOf('COPY docs ./docs')).toBeLessThan(dockerfile.indexOf('RUN cd docs-site && npm test'))
    const ignore = readFileSync('docs-site/Dockerfile.dockerignore', 'utf8').split(/\r?\n/)
    expect(ignore).toEqual(expect.arrayContaining(['!docs/**', '!docs-site/**', '**/node_modules', 'docs-site/.vitepress/dist']))
    const includes = markdownFiles('docs-site').flatMap(file => [...readFileSync(file, 'utf8').matchAll(/<!--@include:\s*(.*?)\s*-->/g)]
      .map(match => resolve(dirname(file), match[1])))
    expect(includes.length).toBeGreaterThanOrEqual(5)
    for (const target of includes) {
      expect(target.startsWith(resolve('docs') + sep)).toBe(true)
      expect(existsSync(target)).toBe(true)
    }
  })

  test('rebuilds when canonical documentation or the Postman generator changes', () => {
    const workflow = readFileSync('.github/workflows/docs-image.yml', 'utf8')
    expect(workflow.match(/- 'docs\/\*\*'/g)).toHaveLength(2)
    expect(workflow.match(/- 'scripts\/openapi-to-postman.mjs'/g)).toHaveLength(2)
  })
})
