import { describe, expect, test } from 'vitest'

import { namesNetworkLocation } from './network-paths'

describe('namesNetworkLocation', () => {
  test.each([
    '\\\\files.example.test\\share\\cat.png',
    '//files.example.test/share/cat.png',
    '\\\\?\\UNC\\files.example.test\\share\\cat.png',
    'file://files.example.test/share/cat.png',
    'file:////files.example.test/share/cat.png',
    'FILE://Files.Example.Test/share/cat.png',
  ])('%s names another machine', (value) => {
    expect(namesNetworkLocation(value)).toBe(true)
  })

  test.each([
    '/Users/dev/shot.png',
    'C:\\Users\\dev\\shot.png',
    'shots/cat.png',
    'file:///Users/dev/shot.png',
    'file://localhost/Users/dev/shot.png',
    'file:///C:/Users/dev/shot.png',
    '\\\\wsl.localhost\\Ubuntu\\home\\dev\\shot.png',
    '//wsl$/Ubuntu/home/dev/shot.png',
    'file://wsl.localhost/Ubuntu/home/dev/shot.png',
  ])('%s is on this computer', (value) => {
    expect(namesNetworkLocation(value)).toBe(false)
  })
})
