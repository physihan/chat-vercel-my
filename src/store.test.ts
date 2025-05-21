import { describe, it, expect, beforeEach, vi } from 'vitest'
import { RootStore, defaultMessage } from './store' // RootStore contains store and setStore
import { defaultEnv } from './env' // To access default token limits
import type { SimpleModel } from './types'
import { batch } from 'solid-js'

// Mock the worker
vi.mock('./wokers', () => ({
  countTokensInWorker: vi.fn((text: string) => Promise.resolve(text.length)) // Simple mock
}))

// Helper to reset store to a known state before each test
const resetStore = () => {
  const { setStore } = RootStore
  batch(() => {
    setStore('globalSettings', { ...defaultEnv.CLIENT_GLOBAL_SETTINGS, customProviderApiKey: '', customProviderApiBaseUrl: '' })
    setStore('sessionSettings', { ...defaultEnv.CLIENT_SESSION_SETTINGS })
    setStore('inputContent', '')
    setStore('messageList', [])
    setStore('currentAssistantMessage', '')
    setStore('contextToken', 0)
    setStore('currentMessageToken', 0)
    setStore('inputContentToken', 0)
    setStore('loading', false)
    // Ensure defaultMessage is re-added if tests clear messageList
    if (RootStore.store.messageList.length === 0) {
        setStore('messageList', [defaultMessage])
    }
  })
}


describe('Store Settings Management', () => {
  beforeEach(() => {
    resetStore()
    // Reset environment variable mocks if any were set directly on process.env
    // For CLIENT_GLOBAL_SETTINGS etc., they are read once at store module initialization.
    // Re-importing or more complex mocking might be needed if those were dynamically changed by tests.
    // However, our store structure initializes globalSettings from defaultEnv then merges meta.env.
    // For these tests, we directly manipulate store.globalSettings via setStore.
  })

  describe('Global Settings Initialization', () => {
    it('should include customProviderApiBaseUrl and customProviderApiKey initialized to empty strings', () => {
      const { store } = RootStore
      expect(store.globalSettings).toHaveProperty('customProviderApiBaseUrl')
      expect(store.globalSettings.customProviderApiBaseUrl).toBe('')
      expect(store.globalSettings).toHaveProperty('customProviderApiKey')
      expect(store.globalSettings.customProviderApiKey).toBe('')
    })
  })

  describe('Session Settings for Custom Models', () => {
    it('should allow setting and retaining an arbitrary string for sessionSettings.model', () => {
      const { store, setStore } = RootStore
      const customModelName = 'my-custom-model/v1.5-large'
      setStore('sessionSettings', 'model', customModelName as SimpleModel)
      expect(store.sessionSettings.model).toBe(customModelName)
    })
  })

  describe('currentModel Computed Property', () => {
    const { store, setStore } = RootStore

    it('should return specific gpt-3.5 model when session model is "gpt-3.5" and token count is low', () => {
      setStore('sessionSettings', 'model', 'gpt-3.5')
      setStore('contextToken', 100)
      setStore('inputContentToken', 50) // Total 150 tokens (0.15k) < 3.5k
      // Logic is: tk < 3.5 ? "4k" : "16k" for gpt-3.5
      // models["gpt-3.5"]["4k"] = "gpt-3.5-turbo-0613"
      expect(store.currentModel).toBe('gpt-3.5-turbo-0613')
    })
    
    it('should return specific gpt-3.5 16k model when session model is "gpt-3.5" and token count is high', () => {
      setStore('sessionSettings', 'model', 'gpt-3.5')
      setStore('contextToken', 3000)
      setStore('inputContentToken', 1000) // Total 4000 tokens (4k) > 3.5k
      // models["gpt-3.5"]["16k"] = "gpt-3.5-turbo-16k-0613"
      expect(store.currentModel).toBe('gpt-3.5-turbo-16k-0613')
    })

    it('should return specific gpt-4 model when session model is "gpt-4" and token count is low', () => {
      setStore('sessionSettings', 'model', 'gpt-4')
      setStore('contextToken', 100)
      setStore('inputContentToken', 50) // Total 150 tokens (0.15k) < 7k
      // Logic is: tk < 7 ? "8k" : "32k" for gpt-4
      // models["gpt-4"]["8k"] = "gpt-4-0613"
      expect(store.currentModel).toBe('gpt-4-0613')
    })
    
    it('should return specific gpt-4 32k model when session model is "gpt-4" and token count is high', () => {
      setStore('sessionSettings', 'model', 'gpt-4')
      setStore('contextToken', 6000)
      setStore('inputContentToken', 2000) // Total 8000 tokens (8k) > 7k
      // models["gpt-4"]["32k"] = "gpt-4-32k-0613"
      expect(store.currentModel).toBe('gpt-4-32k-0613')
    })

    it('should return the custom model string when session model is a custom string', () => {
      const customModelName = 'my-custom-model/v2.0-beta'
      setStore('sessionSettings', 'model', customModelName as SimpleModel)
      setStore('contextToken', 100) // These shouldn't affect custom model name
      setStore('inputContentToken', 50)
      expect(store.currentModel).toBe(customModelName)
    })
  })

  describe('remainingToken Computed Property', () => {
    const { store, setStore } = RootStore

    beforeEach(() => {
      // Set a mock APIKey to use maxInputTokens from store, not defaultEnv
      // Note: The actual maxInputTokens object in store.ts is initialized from defaultEnv.CLIENT_MAX_INPUT_TOKENS
      // and then potentially overridden by parsing import.meta.env.CLIENT_MAX_INPUT_TOKENS.
      // For testing, we assume it's correctly populated like defaultEnv.CLIENT_MAX_INPUT_TOKENS.
      // If CLIENT_MAX_INPUT_TOKENS was also changed by env variables, tests would need to mock that.
      // Here, we are testing the logic based on store.sessionSettings.model and the *values* in maxInputTokens.
      setStore('globalSettings', 'APIKey', 'mock-api-key') 
    })

    it('should calculate remaining tokens based on maxInputTokens["gpt-3.5"] for "gpt-3.5" model', () => {
      const modelName = 'gpt-3.5'
      const expectedMax = defaultEnv.CLIENT_MAX_INPUT_TOKENS[modelName]
      const context = 1000
      const input = 500
      
      setStore('sessionSettings', 'model', modelName)
      setStore('contextToken', context)
      setStore('inputContentToken', input)
      
      expect(store.remainingToken).toBe(expectedMax - context - input)
    })

    it('should return Number.MAX_SAFE_INTEGER for a custom model not in maxInputTokens', () => {
      const customModelName = 'unknown-custom-model-xyz'
      const context = 1000
      const input = 500

      setStore('sessionSettings', 'model', customModelName as SimpleModel)
      setStore('contextToken', context)
      setStore('inputContentToken', input)

      expect(store.remainingToken).toBe(Number.MAX_SAFE_INTEGER)
    })
    
    it('should use defaultEnv.CLIENT_MAX_INPUT_TOKENS if APIKey is not set', () => {
      setStore('globalSettings', 'APIKey', '') // No API key
      const modelName = 'gpt-4' // A model present in defaultEnv
      const expectedMax = defaultEnv.CLIENT_MAX_INPUT_TOKENS[modelName]
      const context = 2000
      const input = 1000

      setStore('sessionSettings', 'model', modelName)
      setStore('contextToken', context)
      setStore('inputContentToken', input)
      
      // The logic in store.ts for remainingToken is:
      // (store.globalSettings.APIKey ? maxInputTokens[model] : defaultEnv.CLIENT_MAX_INPUT_TOKENS[model])
      // Since CLIENT_MAX_INPUT_TOKENS in the store module (maxInputTokens variable) is initialized from defaultEnv
      // and not changed by APIKey presence for this test's purpose (it's about WHICH config obj to use),
      // this test confirms it picks defaultEnv's limits when APIKey is empty.
      expect(store.remainingToken).toBe(expectedMax - context - input)
    })
  })
})
