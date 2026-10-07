import {search} from "./transactions.http";
import {Request, Response} from "express";
import sinon from "sinon";
import {Ledger} from "../../../lib/pay-request/client";

describe('search', () => {
    let redirect: sinon.SinonSpy;

    beforeEach(() => {
        redirect = sinon.fake()
    })

    afterEach(() => {
        sinon.restore();
    })

    describe('id is an email', () => {
        const emailId = 'test@test.com'

        it('should search for transactions by email', () => {
            const listSpy = sinon.fake();
            sinon.replace(Ledger.transactions, 'list', listSpy)
            const request = {body: {id: emailId}} as Request;
            const response = {redirect} as unknown as Response;

            search(request, response, undefined)

            sinon.assert.calledOnceWithMatch(listSpy, {email: emailId})
        })

        it('should redirect to transaction view by email if multiple transactions are found', async () => {
            sinon.replace(Ledger.transactions, 'list', sinon.fake.resolves({results: [{}, {}]}))
            const request = {body: {id: emailId}} as Request;
            const response = {redirect} as unknown as Response;

            await search(request, response, undefined)

            sinon.assert.calledOnceWithExactly(redirect, "/transactions?email=test@test.com")
        })

        it('should redirect to single transaction view by transaction ID if only one transaction is found', async () => {
            const results = [{transaction_id: "transaction-ID"}];
            sinon.replace(Ledger.transactions, 'list', sinon.fake.resolves({results: results}))
            const request = {body: {id: emailId}} as Request;
            const response = {redirect} as unknown as Response;

            await search(request, response, undefined)

            sinon.assert.calledOnceWithExactly(redirect, "/transactions/transaction-ID")
        })
    })

    describe('id is not an email', () => {
        const id = "some-id"

        it('should get transaction by id', () => {
            const retrieveSpy = sinon.fake()
            sinon.replace(Ledger.transactions, 'retrieve', retrieveSpy)
            const request = {body: {id}} as Request;
            const response = {redirect} as unknown as Response;

            search(request, response, undefined)

            sinon.assert.calledOnceWithExactly(retrieveSpy, id)
        })
    })
})