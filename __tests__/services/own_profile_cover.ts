import { OwnProfileCover } from '../../src/services/own_profile_cover'
const fixture = () => {
  const values = new Map<string, string>()
  const redis = { get: jest.fn(async k => values.get(k)), set: jest.fn(async (k,v,options) => { if(options?.NX && values.has(k)) return null; values.set(k,v); return 'OK' }),
    eval: jest.fn(async (script, { keys, arguments: args }) => {
      if (keys.length === 2) { if(values.get(keys[1]) !== args[0]) return 0; values.set(keys[0],args[1]); return 1 }
      if(values.get(keys[0]) === args[0]) { values.delete(keys[0]); return 1 } return 0
    }) }
  const media: any = { type: 's3', saveMediaBuffer: jest.fn().mockResolvedValue(true), removeMedia: jest.fn().mockResolvedValue(undefined), getFileUrl: jest.fn().mockResolvedValue('https://s3.example/preview') }
  return { cover: new OwnProfileCover('5511999999999', media, async () => redis), media, redis, values }
}
test('stores exact JPEG persistently and ID in Redis; signs preview afresh', async () => {
  const {cover,media,values}=fixture(); const image=Buffer.from('jpeg')
  expect(await cover.preview()).toBeNull()
  await expect(cover.upload(image, async()=>({id:'cover1'}))).resolves.toEqual({success:true,id:'cover1'})
  expect(media.saveMediaBuffer).toHaveBeenCalledWith(expect.stringMatching(/^5511999999999\/own-profile-cover\/.*\.jpeg$/),image,'image/jpeg',false)
  const record=JSON.parse(values.get('unoapi-own-profile-cover:v1:5511999999999')!)
  expect(record.id).toBe('cover1'); expect(record.url).toBeUndefined()
  expect(await cover.preview()).toMatchObject({id:'cover1',url:'https://s3.example/preview',source:'uno_upload'})
  expect(media.getFileUrl).toHaveBeenCalledWith(record.object_key,900)
})
test('replacement and removal clean only local tracked objects after success', async()=>{
  const {cover,media}=fixture()
  await cover.upload(Buffer.from('a'),async()=>({id:'a'}))
  const previous=media.saveMediaBuffer.mock.calls[0][0]
  await cover.upload(Buffer.from('b'),async()=>({id:'b'}))
  expect(media.removeMedia).toHaveBeenCalledWith(previous)
  await cover.remove('untracked',async()=>undefined)
  expect((await cover.preview())?.id).toBe('b')
  await expect(cover.remove('b',async()=>{throw Error('refused')})).rejects.toThrow('refused')
  expect((await cover.preview())?.id).toBe('b')
  await cover.remove('b',async()=>undefined); expect(await cover.preview()).toBeNull()
})
test('storage failure prevents remote mutation; provider failure cleans new object; lock excludes concurrency',async()=>{
  const {cover,media,values}=fixture(); const send=jest.fn().mockResolvedValue({id:'x'})
  media.saveMediaBuffer.mockResolvedValueOnce(false)
  await expect(cover.upload(Buffer.from('a'),send)).rejects.toThrow('storage_failed'); expect(send).not.toHaveBeenCalled()
  await expect(cover.upload(Buffer.from('a'),async()=>{throw Error('remote')})).rejects.toThrow('remote')
  expect(media.removeMedia).toHaveBeenCalled()
  values.set('unoapi-own-profile-cover:v1:5511999999999:lock','another')
  await expect(cover.upload(Buffer.from('a'),send)).rejects.toThrow('busy')
})
test('confirmed remote mutation still returns ID when metadata persistence fails',async()=>{
  const {cover,redis}=fixture();redis.eval.mockRejectedValue(new Error('redis down'))
  expect(await cover.upload(Buffer.from('a'),async()=>({id:'keep-me'}))).toEqual({success:true,id:'keep-me',warning:'profile_cover_metadata_not_saved'})
})
