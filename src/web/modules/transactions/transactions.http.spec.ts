import {search} from "./transactions.http";
import {Request, Response} from "express";
import sinon from "sinon";
import {Ledger} from "../../../lib/pay-request/client";

function requestWithId(emailId: string) {
    return {body: {id: emailId}} as Request;
}

function givenLedgerSearchWillReturnResults(...results: any[]) {
    sinon.replace(Ledger.transactions, 'list', sinon.fake.resolves({results}))
}

describe('search', () => {
    let redirectSpy: sinon.SinonSpy;
    let response: Response;

    beforeEach(() => {
        redirectSpy = sinon.fake()
        response = {redirect: redirectSpy} as unknown as Response
    })

    afterEach(() => {
        sinon.restore();
    })

    describe('id is an email', () => {
        const emailId = 'test@test.com'

        it('should search for transactions by email', () => {
            const listSpy = sinon.fake();
            sinon.replace(Ledger.transactions, 'list', listSpy)
            const request = requestWithId(emailId)

            search(request, response, undefined)

            sinon.assert.calledOnceWithMatch(listSpy, {email: emailId})
        })

        it('should redirect to transaction view by email if multiple transactions are found', async () => {
            givenLedgerSearchWillReturnResults({}, {});
            const request = requestWithId(emailId)

            await search(request, response, undefined)

            sinon.assert.calledOnceWithExactly(redirectSpy, "/transactions?email=test@test.com")
        })

        it('should redirect to single transaction view by transaction ID if only one transaction is found', async () => {
            givenLedgerSearchWillReturnResults({transaction_id: "transaction-ID"})
            const request = requestWithId(emailId)

            await search(request, response, undefined)

            sinon.assert.calledOnceWithExactly(redirectSpy, "/transactions/transaction-ID")
        })
    })

    describe('id is not an email', () => {
        const id = "some-id"

        it('should get transaction by id', () => {
            const retrieveSpy = sinon.fake()
            sinon.replace(Ledger.transactions, 'retrieve', retrieveSpy)
            const request = requestWithId(id);

            search(request, response, undefined)

            sinon.assert.calledOnceWithExactly(retrieveSpy, id)
        })

        it('should redirect to single transaction view by transaction ID', async () => {
            sinon.replace(Ledger.transactions, 'retrieve', sinon.fake.resolves({}))
            const request = requestWithId(id)

            await search(request, response, undefined)

            sinon.assert.calledOnceWithExactly(redirectSpy, `/transactions/${id}`)
        })
    })
})