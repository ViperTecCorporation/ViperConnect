export class BindTemplateError extends Error {
  constructor() {
    super('')
  }
}

export class DecryptError extends Error {
  private content: object

  constructor(content: object) {
    super('')
    this.content = content
  }

  getContent() {
    return this.content
  }
}
