import { METAL_API_URL } from '@cmn/constants/url.ts'

const cancelSubscription = async (apiKey: string, subscriptionId: string) => {
  try {
    const myHeaders = new Headers()
    myHeaders.append('x-token', 'solv')
    myHeaders.append(
      'Authorization',
      `Bearer ${apiKey}`,
    )
    myHeaders.append('Content-Type', 'application/json')
    const requestOptions = {
      method: 'DELETE',
      headers: myHeaders,
    }
    const response = await fetch(
      `${METAL_API_URL}/user/subscription/cancel/${subscriptionId}`,
      requestOptions,
    )
    const result = await response.json() as {
      success: boolean
      message: string
    }
    return result
  } catch (error) {
    console.error(error)
    throw new Error('Failed cancelSubscription')
  }
}

export { cancelSubscription }
