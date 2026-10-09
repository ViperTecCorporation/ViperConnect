import { Response } from 'express'
import { getDataStore } from './data_store'
import { Config } from './config'
import { Readable } from 'stream'
import type { WhatsAppContact, WhatsAppMessage } from './whatsapp_types'

export const mediaStores: Map<string, MediaStore> = new Map()

export type ProfilePictureObject = {
  metadata: Record<string, string>
  openStream: () => Promise<Readable>
}

export interface getMediaStore {
  (phone: string, config: Config, getDataStore: getDataStore): MediaStore
}

export type MediaStore = {
  type: string
  getMedia: (baseUrl: string, mediaId: string) => Promise<object | void>
  saveMedia: (waMessage: WhatsAppMessage) => Promise<WhatsAppMessage>
  saveDownloadedMedia?: (waMessage: WhatsAppMessage, buffer: Buffer) => Promise<WhatsAppMessage>
  saveMediaForwarder: <T>(message: T) => Promise<T>
  saveMediaBuffer: (fileName: string, buffer: Buffer, contentType?: string, scheduleRemoval?: boolean) => Promise<boolean>
  saveMediaStream: (fileName: string, stream: Readable, contentType?: string, scheduleRemoval?: boolean, timeoutMs?: number) => Promise<boolean>
  removeMedia: (fileName: string) => Promise<void>
  downloadMedia: (resp: Response, fileName: string) => Promise<void>
  downloadMediaStream: (fileName: string) => Promise<Readable | undefined>
  hasMedia: (fileName: string) => Promise<boolean>
  getFilePath: (phone: string, mediaId: string, mimeType: string, fileName?: string) => string
  getFileUrl: (filePath: string, expiresIn: number) => Promise<string>
  getDownloadUrl: (baseUrl: string, fileName: string) => Promise<string>
  getProfilePictureUrl: (baseUrl: string, jid: string) => Promise<string | undefined>
  getProfilePictureInfo?: (
    baseUrl: string,
    jid: string
  ) => Promise<{ url: string; metadata?: Record<string, string> } | undefined>
  getProfilePictureObject?: (jid: string) => Promise<ProfilePictureObject | undefined>
  saveProfilePicture: (contact: Partial<WhatsAppContact>) => Promise<void>
}
