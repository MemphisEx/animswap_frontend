import { Decimal, Utils } from '@animeswap.org/v1-sdk'
import { Trans } from '@lingui/macro'
import { Trade, TradeType, useAnimeSwapTempTrade } from 'hooks/useBestTrade'
import { TradeState } from 'hooks/useBestTrade'
import { ParsedQs } from 'qs'
import { ReactNode, useCallback, useEffect, useMemo } from 'react'
import { useAppDispatch, useAppSelector } from 'state/hooks'
import { useChainId, useUserSlippageToleranceWithDefault } from 'state/user/hooks'
import { useAccount, useAllCoinBalance, useCoinBalance } from 'state/wallets/hooks'
import { tryParseCoinAmount } from 'utils/tryParseCoinAmount'

import { Coin, useCoin } from '../../hooks/common/Coin'
import useParsedQueryString from '../../hooks/useParsedQueryString'
import { isAddress } from '../../utils'
import { AppState } from '../index'
import { Field, replaceSwapState, selectCurrency, setRecipient, switchCurrencies, typeInput } from './actions'
import { SwapState } from './reducer'

export function useSwapState(): AppState['swap'] {
  return useAppSelector((state) => state.swap)
}

export function useSwapActionHandlers(): {
  onCoinSelection: (field: Field, currency: Coin) => void
  onSwitchTokens: () => void
  onUserInput: (field: Field, typedValue: string) => void
  onChangeRecipient: (recipient: string | null) => void
} {
  const dispatch = useAppDispatch()
  const onCoinSelection = useCallback(
    (field: Field, currency: Coin) => {
      dispatch(
        selectCurrency({
          field,
          currencyId: currency.address,
        })
      )
    },
    [dispatch]
  )

  const onSwitchTokens = useCallback(() => {
    dispatch(switchCurrencies())
  }, [dispatch])

  const onUserInput = useCallback(
    (field: Field, typedValue: string) => {
      dispatch(typeInput({ field, typedValue }))
    },
    [dispatch]
  )

  const onChangeRecipient = useCallback(
    (recipient: string | null) => {
      dispatch(setRecipient({ recipient }))
    },
    [dispatch]
  )

  return {
    onSwitchTokens,
    onCoinSelection,
    onUserInput,
    onChangeRecipient,
  }
}

// from the current swap inputs, compute the best trade and return it.
export function useDerivedSwapInfo(): {
  coins: { [field in Field]?: Coin | null }
  coinBalances: { [field in Field]?: Decimal }
  isExactIn: boolean
  parsedAmount: Decimal
  inputError?: ReactNode
  trade: {
    state: TradeState
    trade: Trade
  }
  allowedSlippage: Decimal
} {
  const account = useAccount()
  const allCoinBalances = useAllCoinBalance()

  const {
    independentField,
    typedValue,
    [Field.INPUT]: { currencyId: inputCurrencyId },
    [Field.OUTPUT]: { currencyId: outputCurrencyId },
    recipient,
  } = useSwapState()

  const inputCoin = useCoin(inputCurrencyId)
  const outputCoin = useCoin(outputCurrencyId)

  const to: string | null = (recipient === null ? account : recipient) ?? null

  const isExactIn: boolean = independentField === Field.INPUT

  const parsedAmount = useMemo(
    () => tryParseCoinAmount(typedValue, (isExactIn ? inputCoin : outputCoin) ?? undefined),
    [inputCoin, isExactIn, outputCoin, typedValue]
  )

  const trade = useAnimeSwapTempTrade(
    isExactIn ? TradeType.EXACT_INPUT : TradeType.EXACT_OUTPUT,
    parsedAmount,
    inputCoin,
    outputCoin
  )

  const coinBalances = useMemo(
    () => ({
      [Field.INPUT]: Utils.d(allCoinBalances[inputCoin?.address]),
      [Field.OUTPUT]: Utils.d(allCoinBalances[outputCoin?.address]),
    }),
    [allCoinBalances, inputCoin, outputCoin]
  )

  const coins: { [field in Field]?: Coin | null } = useMemo(
    () => ({
      [Field.INPUT]: inputCoin,
      [Field.OUTPUT]: outputCoin,
    }),
    [inputCoin, outputCoin]
  )

  const allowedSlippage = Utils.d(50).div(10000)

  const inputError = useMemo(() => {
    let inputError: ReactNode | undefined

    if (!account) {
      inputError = <Trans>Connect Wallet</Trans>
    }

    if (!coins[Field.INPUT] || !coins[Field.OUTPUT]) {
      inputError = inputError ?? <Trans>Select a coin</Trans>
    }

    if (!parsedAmount) {
      inputError = inputError ?? <Trans>Enter an amount</Trans>
    }

    const formattedTo = isAddress(to)
    if (!to || !formattedTo) {
      inputError = inputError ?? <Trans>Enter a recipient</Trans>
    }
    // compare input balance to max input based on version
    const [balanceIn, amountIn] = [coinBalances[Field.INPUT], trade.trade?.maximumAmountIn]
    if (balanceIn && amountIn && balanceIn < amountIn) {
      inputError = <Trans>Insufficient {inputCoin.symbol} balance</Trans>
    }

    if (trade.state === TradeState.NO_ROUTE_FOUND) {
      inputError = inputError ?? <Trans>No route found</Trans>
    }

    return inputError
  }, [account, allowedSlippage, coins, coinBalances, parsedAmount, to, trade.trade])

  return useMemo(
    () => ({
      coins,
      coinBalances,
      isExactIn,
      parsedAmount,
      inputError,
      trade,
      allowedSlippage,
    }),
    [allowedSlippage, coins, isExactIn, inputError, parsedAmount, trade]
  )
}

function parseCurrencyFromURLParameter(urlParam: ParsedQs[string]): string {
  if (typeof urlParam === 'string') {
    const valid = isAddress(urlParam)
    if (valid) return valid
  }
  return ''
}

function parseTokenAmountURLParameter(urlParam: any): string {
  return typeof urlParam === 'string' && !isNaN(parseFloat(urlParam)) ? urlParam : ''
}

function parseIndependentFieldURLParameter(urlParam: any): Field {
  return typeof urlParam === 'string' && urlParam.toLowerCase() === 'output' ? Field.OUTPUT : Field.INPUT
}

const ENS_NAME_REGEX = /^[-a-zA-Z0-9@:%._+~#=]{1,256}\.[a-zA-Z0-9()]{1,6}\b([-a-zA-Z0-9()@:%_+.~#?&/=]*)?$/
const ADDRESS_REGEX = /^0x[a-fA-F0-9]{40}$/
function validatedRecipient(recipient: any): string | null {
  if (typeof recipient !== 'string') return null
  const address = isAddress(recipient)
  if (address) return address
  if (ENS_NAME_REGEX.test(recipient)) return recipient
  if (ADDRESS_REGEX.test(recipient)) return recipient
  return null
}

export function queryParametersToSwapState(parsedQs: ParsedQs): SwapState {
  let inputCurrency = parseCurrencyFromURLParameter(parsedQs.inputCurrency)
  let outputCurrency = parseCurrencyFromURLParameter(parsedQs.outputCurrency)
  const typedValue = parseTokenAmountURLParameter(parsedQs.exactAmount)
  const independentField = parseIndependentFieldURLParameter(parsedQs.exactField)
  if (inputCurrency === '' && outputCurrency === '' && typedValue === '' && independentField === Field.INPUT) {
    // Defaults to having the native currency selected
    inputCurrency = '0x1::aptos_coin::AptosCoin' // default to APT
  } else if (inputCurrency === outputCurrency) {
    // clear output if identical
    outputCurrency = ''
  }

  const recipient = validatedRecipient(parsedQs.recipient)

  return {
    [Field.INPUT]: {
      currencyId: inputCurrency === '' ? null : inputCurrency ?? null,
    },
    [Field.OUTPUT]: {
      currencyId: outputCurrency === '' ? null : outputCurrency ?? null,
    },
    typedValue,
    independentField,
    recipient,
  }
}

// Azard: init swap token
// updates the swap state to use the defaults for a given network
export function useDefaultsFromURLSearch(): SwapState {
  const chainId = useChainId()
  const dispatch = useAppDispatch()
  const parsedQs = useParsedQueryString()

  const parsedSwapState = useMemo(() => {
    return queryParametersToSwapState(parsedQs)
  }, [parsedQs])

  useEffect(() => {
    if (!chainId) return
    const inputCurrencyId = parsedSwapState[Field.INPUT].currencyId ?? undefined
    const outputCurrencyId = parsedSwapState[Field.OUTPUT].currencyId ?? undefined

    dispatch(
      replaceSwapState({
        typedValue: parsedSwapState.typedValue,
        field: parsedSwapState.independentField,
        inputCurrencyId,
        outputCurrencyId,
        recipient: parsedSwapState.recipient,
      })
    )

    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dispatch, chainId])

  return parsedSwapState
}