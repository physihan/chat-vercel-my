import type { ParsedEvent, ReconnectInterval } from "eventsource-parser"
import { createParser } from "eventsource-parser"
import type { ChatMessage, Model } from "~/types"
import { splitKeys, randomKey, fetchWithTimeout } from "~/utils"
import { defaultEnv } from "~/env"
import type { APIEvent } from "solid-start/api"

export const config = {
  runtime: "edge",
  /**
   * https://vercel.com/docs/concepts/edge-network/regions#region-list
   * disable hongkong
   * only for vercel
   */
  regions: [
    "arn1",
    "bom1",
    "bru1",
    "cdg1",
    "cle1",
    "cpt1a",
    "dub1",
    "fra1",
    "gru1",
    "hnd1",
    "iad1",
    "icn1",
    "kix1",
    "lhr1",
    "pdx1",
    "sfo1",
    "sin1",
    "syd1"
  ]
}

export const localKey = process.env.OPENAI_API_KEY || ""
export const customProviderApiKey = process.env.CUSTOM_PROVIDER_API_KEY || ""

const openAIBaseURL = (
  process.env.OPENAI_API_BASE_URL || defaultEnv.OPENAI_API_BASE_URL
).replace(/^https?:\/\//, "")

const customProviderBaseURL = (
  process.env.CUSTOM_PROVIDER_API_BASE_URL || ""
).replace(/^https?:\/\//, "")

// const baseURL is no longer needed as targetBaseURL is determined dynamically.
// The NO_GFW logic is handled during targetBaseURL selection for OpenAI models.

// + 作用是将字符串转换为数字
const timeout = isNaN(+process.env.TIMEOUT!)
  ? defaultEnv.TIMEOUT
  : +process.env.TIMEOUT!

const passwordSet = process.env.PASSWORD || defaultEnv.PASSWORD

export async function POST({ request }: APIEvent) {
  try {
    const body: {
      messages?: ChatMessage[]
      key?: string
      temperature: number
      password?: string
      model: Model
    } = await request.json()
    const { messages, key = localKey, temperature, password, model } = body

    if (passwordSet && password !== passwordSet) {
      throw new Error("密码错误，请联系网站管理员。")
    }

    if (!messages?.length) {
      throw new Error("没有输入任何文字。")
    } else {
      const content = messages.at(-1)!.content.trim()
      if (content.startsWith("查询填写的 Key 的余额")) {
        if (key !== localKey) {
          const billings = await Promise.all(
            splitKeys(key).map(k => fetchBilling(k))
          )
          return new Response(await genBillingsTable(billings))
        } else {
          throw new Error("没有填写 OpenAI API key，不会查询内置的 Key。")
        }
      } else if (content.startsWith("sk-")) {
        const billings = await Promise.all(
          splitKeys(content).map(k => fetchBilling(k))
        )
        return new Response(await genBillingsTable(billings))
      }
    }

    let targetBaseURL = "";
    let targetApiKey = "";

    if (model.startsWith("gpt-3.5") || model.startsWith("gpt-4")) {
      targetBaseURL = process.env.NO_GFW !== "false"
        ? defaultEnv.OPENAI_API_BASE_URL.replace(/^https?:\/\//, "")
        : openAIBaseURL;
      targetApiKey = randomKey(splitKeys(key));
      if (!targetApiKey && !localKey) { // if client key is empty and server localKey is also empty
        throw new Error("没有填写 OpenAI API key，或者 key 填写错误。");
      }
      if (!targetApiKey && localKey) { // if client key is empty, use server localKey
        targetApiKey = localKey;
      }
    } else {
      // Custom model
      if (!customProviderBaseURL) {
        throw new Error(
          "Custom provider API base URL (CUSTOM_PROVIDER_API_BASE_URL) is not configured on the server."
        );
      }
      targetBaseURL = customProviderBaseURL;
      targetApiKey = customProviderApiKey; // Use server-defined key for custom provider
      // We can allow empty customProviderApiKey if the provider does not require one.
      // For now, let's assume it might be required, but don't throw if it's empty,
      // as the provider might authenticate in other ways or be an open service.
      // The actual API call will fail if the key is required and not provided.
    }
    
    if (!targetApiKey && (model.startsWith("gpt-3.5") || model.startsWith("gpt-4"))) {
      // This case should ideally be caught by the OpenAI specific check above,
      // but as a safeguard for OpenAI models if somehow randomKey returns empty and localKey was also empty.
      throw new Error("OpenAI API key is missing.");
    }
    // For custom models, targetApiKey can be empty if CUSTOM_PROVIDER_API_KEY is not set.
    // The request will proceed, and the custom provider will decide if it's acceptable.

    const encoder = new TextEncoder()
    const decoder = new TextDecoder()

    const fetchUrl = `https://${targetBaseURL}/v1/chat/completions`;
    // Ensure custom providers expecting non-OpenAI paths can be handled if targetBaseURL includes the full path.
    // For now, assuming /v1/chat/completions is standard.
    // A more robust solution might involve having CUSTOM_PROVIDER_API_ENDPOINT_PATH in env.

    const rawRes = await fetchWithTimeout(
      fetchUrl,
      {
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${targetApiKey}`
        },
        timeout,
        method: "POST",
        body: JSON.stringify({
          model,
          messages: messages.map(k => ({ role: k.role, content: k.content })),
          temperature,
          stream: true
        })
      }
    ).catch((err: { message: any }) => {
      return new Response(
        JSON.stringify({
          error: {
            message: err.message
          }
        }),
        { status: 500 }
      )
    })

    if (!rawRes.ok) {
      return new Response(rawRes.body, {
        status: rawRes.status,
        statusText: rawRes.statusText
      })
    }

    const stream = new ReadableStream({
      async start(controller) {
        const streamParser = (event: ParsedEvent | ReconnectInterval) => {
          if (event.type === "event") {
            const data = event.data
            if (data === "[DONE]") {
              controller.close()
              return
            }
            try {
              const json = JSON.parse(data)
              const text = json.choices[0].delta?.content
              const queue = encoder.encode(text)
              controller.enqueue(queue)
            } catch (e) {
              controller.error(e)
            }
          }
        }
        const parser = createParser(streamParser)
        for await (const chunk of rawRes.body as any) {
          parser.feed(decoder.decode(chunk))
        }
      }
    })

    return new Response(stream)
  } catch (err: any) {
    return new Response(
      JSON.stringify({
        error: {
          message: err.message
        }
      }),
      { status: 400 }
    )
  }
}

type Billing = {
  key: string
  rate: number
  totalGranted: number
  totalUsed: number
  totalAvailable: number
}

export async function fetchBilling(key: string): Promise<Billing> {
  function formatDate(date: any) {
    const year = date.getFullYear()
    const month = (date.getMonth() + 1).toString().padStart(2, "0")
    const day = date.getDate().toString().padStart(2, "0")
    return `${year}-${month}-${day}`
  }
  try {
    const now = new Date()
    const startDate = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000)
    const endDate = new Date(now.getTime() + 24 * 60 * 60 * 1000)

    // 设置API请求URL和请求头
    const urlSubscription =
      "https://api.openai.com/v1/dashboard/billing/subscription" // 查是否订阅
    const urlUsage = `https://api.openai.com/v1/dashboard/billing/usage?start_date=${formatDate(
      startDate
    )}&end_date=${formatDate(endDate)}` // 查使用量
    const headers = {
      Authorization: "Bearer " + key,
      "Content-Type": "application/json"
    }

    // 获取API限额
    const subscriptionData = await fetch(urlSubscription, { headers }).then(r =>
      r.json()
    )
    if (subscriptionData.error?.message)
      throw new Error(subscriptionData.error.message)
    const totalGranted = subscriptionData.hard_limit_usd
    // 获取已使用量
    const usageData = await fetch(urlUsage, { headers }).then(r => r.json())
    const totalUsed = usageData.total_usage / 100
    // 计算剩余额度
    const totalAvailable = totalGranted - totalUsed
    return {
      totalGranted,
      totalUsed,
      totalAvailable,
      key,
      rate: totalAvailable / totalGranted
    }
  } catch (e) {
    console.error(e)
    return {
      key,
      rate: 0,
      totalGranted: 0,
      totalUsed: 0,
      totalAvailable: 0
    }
  }
}

export async function genBillingsTable(billings: Billing[]) {
  const table = billings
    .sort((m, n) => (m.totalGranted === 0 ? -1 : n.rate - m.rate))
    .map((k, i) => {
      if (k.totalGranted === 0)
        return `| ${k.key.slice(0, 8)} | 不可用 | —— | —— |`
      return `| ${k.key.slice(0, 8)} | ${k.totalAvailable.toFixed(4)}(${(
        k.rate * 100
      ).toFixed(1)}%) | ${k.totalUsed.toFixed(4)} | ${k.totalGranted} |`
    })
    .join("\n")

  return `| Key  | 剩余 | 已用 | 总额度 |
| ---- | ---- | ---- | ------ |
${table}
`
}
