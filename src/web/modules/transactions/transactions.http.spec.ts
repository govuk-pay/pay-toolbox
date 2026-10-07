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

        it('should call the next function with the thrown error if an error is thrown by Ledger "list" operation', () => {
            const error = new Error('error');
            const listStub = sinon.fake.throws(error);
            sinon.replace(Ledger.transactions, 'list', listStub)
            const request = requestWithId(emailId)
            const nextFunctionSpy = sinon.spy()

            search(request, response, nextFunctionSpy)

            sinon.assert.calledOnceWithExactly(nextFunctionSpy, error)
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

        describe('transaction is not found by ID', () => {
            // EntityNotFoundError is thrown from Ledger.transactions.retrieve

            // search by reference
            //     multiple results are returned - redirects to transactions by reference
            //     one result is returned - redirects to transaction view by ID for result
            // search by gateway transaction ID if not found by reference
            //     multiple results are returned - redirects to transactions by gateway transaction id
            //     one result is returned - redirects to transaction view by ID for result
            // calls next function with EntityNotFoundError if search by reference and gateway transaction ID return no results
        })
    })
})