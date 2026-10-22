import { search } from "./transactions.http"
import { Request, Response } from "express"
import sinon from "sinon"
import { Ledger } from "../../../lib/pay-request/client"
import { EntityNotFoundError } from "../../../lib/errors"
import { describe, it, beforeEach, afterEach } from "mocha"

function requestWithId(id: string) {
  return { body: { id } } as Request
}

function givenLedgerSearchWillReturnResults(...results: any[]) {
  sinon.replace(Ledger.transactions, 'list', sinon.fake.resolves({ results }))
}

function givenTransactionDoesNotExist() {
  const error = new EntityNotFoundError('Transaction does not exist', 'an-identifier')
  sinon.replace(Ledger.transactions, 'retrieve', sinon.fake.rejects(error))
}

function givenReferenceSearchFailsAndGatewayReturns(...results: any[]) {
  const listStub = sinon.stub()
  sinon.replace(Ledger.transactions, 'list', listStub)
  listStub.onFirstCall().resolves({ results: [] })
  listStub.onSecondCall().resolves({ results })
  return listStub
}

describe('Transaction search', () => {
  let redirectSpy: sinon.SinonSpy
  let nextSpy: sinon.SinonSpy
  let response: Response

  beforeEach(() => {
    redirectSpy = sinon.fake()
    nextSpy = sinon.fake()
    response = { redirect: redirectSpy } as unknown as Response
  })

  afterEach(() => {
    sinon.restore()
  })

  describe('id is an email', () => {
    const email = 'test@test.com'
    const request = requestWithId(email)

    it('searches for transactions by email', () => {
      const listSpy = sinon.fake()
      sinon.replace(Ledger.transactions, 'list', listSpy)

      search(request, response, nextSpy)

      sinon.assert.calledOnceWithMatch(listSpy, { email })
    })

    it('redirects to transaction view by email if multiple transactions are found', async () => {
      givenLedgerSearchWillReturnResults({}, {})

      await search(request, response, nextSpy)

      sinon.assert.calledOnceWithExactly(redirectSpy, `/transactions?email=${email}`)
    })

    it('redirects to single transaction view by transaction ID if only one transaction is found', async () => {
      const transaction_id = "transaction-ID"
      givenLedgerSearchWillReturnResults({ transaction_id })

      await search(request, response, nextSpy)

      sinon.assert.calledOnceWithExactly(redirectSpy, `/transactions/${transaction_id}`)
    })

    it('calls next() with the error when Ledger.list fails', () => {
      const error = new Error('error')
      sinon.replace(Ledger.transactions, 'list', sinon.fake.throws(error))

      search(request, response, nextSpy)

      sinon.assert.calledOnceWithExactly(nextSpy, error)
    })
  })

  describe('id is not an email', () => {
    const id = "eq3tu5mod3m0evp18orocr35th"
    const request = requestWithId(id)

    describe('and id contains special characters (/ or ?)', () => {
      const reference = "ref/with/slash?"

      it('bypasses direct retrieve and queries transactions by reference', () => {
        const retrieveSpy = sinon.fake()
        const listSpy = sinon.fake()
        sinon.replace(Ledger.transactions, 'retrieve', retrieveSpy)
        sinon.replace(Ledger.transactions, 'list', listSpy)

        search(requestWithId(reference), response, nextSpy)

        sinon.assert.notCalled(retrieveSpy)
        sinon.assert.calledOnceWithMatch(listSpy, { reference })
      })
    })

    describe('and transaction exists by direct id', () => {
      it('retrieves the transaction directly by id', () => {
        const retrieveSpy = sinon.fake()
        sinon.replace(Ledger.transactions, 'retrieve', retrieveSpy)

        search(request, response, nextSpy)

        sinon.assert.calledOnceWithExactly(retrieveSpy, id)
      })

      it('redirects directly to the single transaction view', async () => {
        sinon.replace(Ledger.transactions, 'retrieve', sinon.fake.resolves({}))

        await search(request, response, nextSpy)

        sinon.assert.calledOnceWithExactly(redirectSpy, `/transactions/${id}`)
      })
    })

    describe('and transaction is not found by id (fallback to reference)', () => {
      beforeEach(() => {
        givenTransactionDoesNotExist()
      })

      it('searches for transactions by reference', async () => {
        const listSpy = sinon.fake()
        sinon.replace(Ledger.transactions, 'list', listSpy)

        await search(request, response, nextSpy)

        sinon.assert.calledOnceWithMatch(listSpy, { reference: id })
      })

      it('redirects to transaction view by reference if multiple transactions are found by reference', async () => {
        givenLedgerSearchWillReturnResults({}, {})

        await search(request, response, nextSpy)

        sinon.assert.calledOnceWithExactly(redirectSpy, `/transactions?reference=${id}`)
      })

      it('redirects to single transaction view by transaction ID if only one transaction is found by reference', async () => {
        const transaction_id = "transaction-ID"
        givenLedgerSearchWillReturnResults({ transaction_id })

        await search(request, response, nextSpy)

        sinon.assert.calledOnceWithExactly(redirectSpy, `/transactions/${transaction_id}`)
      })
    })

    describe('and transaction is not found by reference (fallback to gateway id)', () => {
      beforeEach(() => {
        givenTransactionDoesNotExist()
      })

      it('searches for transactions by gateway transaction ID', async () => {
        const listSpy = sinon.fake.resolves({ results: [] })
        sinon.replace(Ledger.transactions, 'list', listSpy)

        await search(request, response, nextSpy)

        sinon.assert.calledWithMatch(listSpy, { gateway_transaction_id: id })
      })

      it('redirects to transaction view by gateway transaction ID if multiple transactions are found', async () => {
        givenReferenceSearchFailsAndGatewayReturns({}, {})

        await search(request, response, nextSpy)

        sinon.assert.calledOnceWithExactly(redirectSpy, `/transactions?gateway_transaction_id=${id}`)
      })

      it('redirects to single transaction view by transaction ID if only one transaction is found by gateway transaction ID', async () => {
        givenReferenceSearchFailsAndGatewayReturns({ transaction_id: id })

        await search(request, response, nextSpy)

        sinon.assert.calledOnceWithExactly(redirectSpy, `/transactions/${id}`)
      })

      it('calls next() with an EntityNotFoundError if transaction is not found by either reference or gateway transaction ID', async () => {
        givenReferenceSearchFailsAndGatewayReturns()

        await search(request, response, nextSpy)

        sinon.assert.calledOnceWithMatch(
          nextSpy,
          sinon.match.instanceOf(EntityNotFoundError)
            .and(sinon.match.has('message', `Transaction search with criteria  with ID ${id} was not found.`))
        )
      })
    })
  })
})