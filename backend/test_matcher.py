import time
import unittest
from pathlib import Path
import sys
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).parent))
from main import AmazonBlocked, AmazonOfferRequest, MatchRequest, build_search_queries, classify_candidate, extract_amazon_candidates, extract_amazon_product_details, extract_seller_name, get_amazon_offer, match_product, search_amazon


class MatcherTests(unittest.TestCase):
    def test_exact_ean_is_high_match(self):
        product = MatchRequest(ean="5012345678900", title="Daily Hand Cream", brand="Northstar")
        candidate = {
            "title": "Northstar Daily Hand Cream 75ml",
            "cardText": "Northstar Daily Hand Cream 75ml EAN: 5012345678900",
            "imageUrl": "https://m.media-amazon.com/images/I/example.jpg",
            "productUrl": "https://www.amazon.co.uk/dp/B012345678",
        }

        result = classify_candidate(product, candidate)

        self.assertIsNotNone(result)
        self.assertEqual(result["tier"], "high")
        self.assertTrue(result["eanMatch"])

    def test_title_brand_variant_and_size_is_medium(self):
        product = MatchRequest(
            ean="5012345678900",
            title="Hydrating Hand Cream",
            brand="Northstar",
            variant="Rose",
            size="250 ml",
        )
        candidate = {
            "title": "Northstar Hydrating Hand Cream Rose 250ml",
            "cardText": "Northstar Hydrating Hand Cream Rose 250ml",
            "imageUrl": "https://m.media-amazon.com/images/I/example.jpg",
        }

        result = classify_candidate(product, candidate)

        self.assertIsNotNone(result)
        self.assertEqual(result["tier"], "medium")
        self.assertTrue(result["brandMatch"])
        self.assertTrue(result["variantMatch"])
        self.assertTrue(result["sizeMatch"])
        self.assertTrue(result["packMatch"])

    def test_category_synonym_can_match_with_confirmed_size(self):
        product = MatchRequest(title="Soap", brand="Northstar", size="250 ml", category="soap_hygiene")
        candidate = {
            "title": "Northstar Hand Wash 250ml",
            "cardText": "Northstar Hand Wash 250ml",
            "imageUrl": "https://m.media-amazon.com/images/I/example.jpg",
        }

        result = classify_candidate(product, candidate)

        self.assertIsNotNone(result)
        self.assertEqual(result["tier"], "medium")
        self.assertIn("product category", result["reason"])

    def test_category_terms_expand_search_queries_one_at_a_time(self):
        product = MatchRequest(title="Gentle Soap", brand="Northstar", category="soap_hygiene")

        queries = build_search_queries(product)

        category_queries = [query for stage, query in queries if stage == "category"]
        self.assertEqual(
            category_queries,
            [
                "Northstar Gentle Soap antibacterial",
                "Northstar Gentle Soap caring",
                "Northstar Gentle Soap protective",
                "Northstar Gentle Soap cleansing",
            ],
        )
        self.assertLessEqual(len(queries), 5)

    def test_supplier_carets_are_removed_before_querying(self):
        product = MatchRequest(title="Gent^le Hand^wash", brand="North^star", category="soap_hygiene")

        queries = build_search_queries(product)

        self.assertEqual(queries[0], ("detail", "Northstar Gentle Handwash"))
        self.assertTrue(all("^" not in query for _, query in queries))

    def test_image_terms_supplement_title_size_and_pack_search(self):
        product = MatchRequest(
            title="Carex Antibacterial Sensitive Handwash",
            image_terms="Carex purple pump bottle sensitive hand soap",
            size="250ml",
            pack="1",
        )

        queries = build_search_queries(product)

        self.assertEqual(queries[0][0], "image")
        image_query = queries[0][1]
        self.assertIn("Carex Antibacterial Sensitive Handwash", image_query)
        self.assertIn("purple pump bottle sensitive", image_query)
        self.assertIn("250ml", image_query)
        self.assertIn("1", image_query)

    def test_label_terms_improve_candidate_title_matching(self):
        product = MatchRequest(title="Hand Wash", image_terms="Carex Antibacterial Sensitive", brand="Carex")
        candidate = {
            "title": "Carex Antibacterial Sensitive Hand Wash 250ml",
            "cardText": "Carex Antibacterial Sensitive Hand Wash 250ml",
            "imageUrl": "https://m.media-amazon.com/images/I/example.jpg",
        }

        result = classify_candidate(product, candidate)

        self.assertEqual(result["tier"], "medium")
        self.assertGreater(result["titleScore"], 0.7)

    def test_size_uncertainty_is_low_match(self):
        product = MatchRequest(title="Hydrating Hand Cream", brand="Northstar", size="250 ml")
        candidate = {
            "title": "Northstar Hydrating Hand Cream 100ml",
            "cardText": "Northstar Hydrating Hand Cream 100ml",
            "imageUrl": "https://m.media-amazon.com/images/I/example.jpg",
        }

        result = classify_candidate(product, candidate)

        self.assertIsNotNone(result)
        self.assertEqual(result["tier"], "low")
        self.assertFalse(result["sizeMatch"])

    def test_nearby_title_is_retained_as_a_low_confidence_choice(self):
        product = MatchRequest(title="Antibacterial Hand Wash", brand="Northstar", size="250 ml")
        candidate = {
            "title": "Northstar Hand Cleanser 250ml",
            "cardText": "Northstar Hand Cleanser 250ml",
            "imageUrl": "https://m.media-amazon.com/images/I/example.jpg",
        }

        result = classify_candidate(product, candidate)

        self.assertIsNotNone(result)
        self.assertEqual(result["tier"], "low")
        self.assertIn("compare the image", result["reason"])

    def test_unrelated_listing_is_kept_for_manual_review(self):
        product = MatchRequest(title="Hydrating Hand Cream", brand="Northstar", size="250 ml")
        candidate = {
            "title": "Wireless Bluetooth Headphones",
            "cardText": "Wireless Bluetooth Headphones",
            "imageUrl": "https://m.media-amazon.com/images/I/example.jpg",
        }

        result = classify_candidate(product, candidate)

        self.assertEqual(result["tier"], "low")
        self.assertIn("source brand", result["reason"])

    def test_ten_percent_title_overlap_is_kept_as_a_low_option(self):
        product = MatchRequest(title="Imperial Leather Bath Muscle Soak Bergamot Sensitive Aloe Botanical Celestial")
        candidate = {
            "title": "Imperial Radox Body Wash",
            "cardText": "Imperial Radox Body Wash",
            "imageUrl": "https://m.media-amazon.com/images/I/example.jpg",
        }

        result = classify_candidate(product, candidate)

        self.assertEqual(result["tier"], "low")
        self.assertIn("10%", result["reason"])
        self.assertIn("manual review", result["reason"])

    def test_search_result_parser_extracts_title_image_and_ean(self):
        html = '''
        <div data-component-type="s-search-result" data-asin="B012345678">
          <h2><a href="/dp/B012345678"><span>Northstar Hand Cream 250ml</span></a></h2>
          <img class="s-image" src="https://m.media-amazon.com/images/I/example.jpg" />
          <span>EAN 5012345678900</span>
        </div>
        '''

        results = extract_amazon_candidates(html, "5012345678900")

        self.assertEqual(len(results), 1)
        self.assertEqual(results[0]["title"], "Northstar Hand Cream 250ml")
        self.assertTrue(results[0]["eanMatch"])
        self.assertEqual(results[0]["productUrl"], "https://www.amazon.co.uk/dp/B012345678")

    def test_search_result_parser_prefers_full_amazon_title_and_extracts_seller(self):
        html = '''
        <div data-component-type="s-search-result" data-asin="B012345678">
          <h2><a href="/dp/B012345678" title="Spontex Heavy Duty Scourer Pads, 3 Count"><span>Spontex</span></a></h2>
          <img class="s-image" src="https://m.media-amazon.com/images/I/example.jpg" alt="Spontex" />
          <span>Sold by: Amazon.co.uk</span>
        </div>
        '''

        results = extract_amazon_candidates(html, "")

        self.assertEqual(results[0]["title"], "Spontex Heavy Duty Scourer Pads, 3 Count")
        self.assertEqual(results[0]["seller"], "Amazon.co.uk")

    def test_search_result_parser_extracts_every_listing_on_the_page(self):
        listings = "".join(
            f'''<div data-component-type="s-search-result" data-asin="B00000{index:04d}">
              <h2><a href="/dp/B00000{index:04d}">Nivea Men Sensitive Shower Gel 250ml Pack of {index}</a></h2>
              <img class="s-image" src="https://m.media-amazon.com/images/I/item-{index}.jpg" />
            </div>'''
            for index in range(1, 13)
        )

        results = extract_amazon_candidates(listings, "")

        self.assertEqual(len(results), 12)
        self.assertEqual(results[-1]["asin"], "B000000012")

    def test_search_result_without_an_image_is_kept_for_title_review(self):
        html = '''
        <div data-component-type="s-search-result" data-asin="B012345678">
          <h2><a href="/dp/B012345678">Northstar Hand Cream 250ml</a></h2>
          <img class="s-image" alt="Product photo unavailable" />
        </div>
        '''

        results = extract_amazon_candidates(html, "")

        self.assertEqual(len(results), 1)
        self.assertEqual(results[0]["title"], "Northstar Hand Cream 250ml")
        self.assertEqual(results[0]["imageUrl"], "")

    def test_single_amazon_item_gets_supplier_pack_equivalent_price(self):
        product = MatchRequest(title="Sensitive Shower Gel", brand="Nivea Men", size="250ml", pack="6")
        candidate = {
            "title": "Nivea Men Sensitive Shower Gel 250ml",
            "cardText": "Nivea Men Sensitive Shower Gel 250ml",
            "imageUrl": "https://m.media-amazon.com/images/I/example.jpg",
            "price": "£2.00",
        }

        result = classify_candidate(product, candidate)

        self.assertFalse(result["packMatch"])
        self.assertEqual(result["amazonPackCount"], 1)
        self.assertEqual(result["amazonUnitPrice"], "£2.00")
        self.assertEqual(result["supplierPackEquivalentPrice"], "£12.00")

    def test_multipack_price_is_normalized_to_an_individual_item(self):
        product = MatchRequest(title="Sensitive Shower Gel", brand="Nivea Men", size="250ml", pack="6")
        candidate = {
            "title": "Nivea Men Sensitive Shower Gel 4 x 250ml",
            "cardText": "Nivea Men Sensitive Shower Gel 4 x 250ml",
            "imageUrl": "https://m.media-amazon.com/images/I/example.jpg",
            "price": "£8.95",
        }

        result = classify_candidate(product, candidate)

        self.assertEqual(result["amazonPackCount"], 4)
        self.assertEqual(result["amazonUnitPrice"], "£2.24")
        self.assertEqual(result["supplierPackEquivalentPrice"], "£13.43")

    def test_lookup_scans_the_full_first_relevant_result_page(self):
        candidates = [
            {
                "asin": f"B00000{index:04d}",
                "title": f"Nivea Men Sensitive Shower Gel 250ml Pack of {index}",
                "cardText": f"Nivea Men Sensitive Shower Gel 250ml Pack of {index}",
                "imageUrl": f"https://m.media-amazon.com/images/I/item-{index}.jpg",
                "productUrl": f"https://www.amazon.co.uk/dp/B00000{index:04d}",
                "price": "£2.00",
            }
            for index in range(1, 13)
        ]
        product = MatchRequest(title="Sensitive Shower Gel", brand="Nivea Men", size="250ml", pack="6")

        with patch("main.search_amazon", return_value=candidates) as search, patch("main.get_regal_image", return_value=""):
            result = match_product(product)

        search.assert_called_once()
        self.assertEqual(result["scannedCandidateCount"], 12)
        self.assertEqual(len(result["candidates"]), 12)
        self.assertTrue(any(candidate["amazonPackCount"] == 1 for candidate in result["candidates"]))

    def test_product_page_parser_extracts_full_title_seller_and_current_price(self):
        html = '''
        <span id="productTitle">Spontex Heavy Duty Scourer Pads, Pack of 3</span>
        <a id="sellerProfileTriggerId">Amazon.co.uk</a>
        <div id="corePrice_feature_div"><span class="a-offscreen">£2.49</span></div>
        '''

        details = extract_amazon_product_details(html)

        self.assertEqual(details["amazonTitle"], "Spontex Heavy Duty Scourer Pads, Pack of 3")
        self.assertEqual(details["seller"], "Amazon.co.uk")
        self.assertEqual(details["price"], "£2.49")

    def test_product_page_parser_reads_shipper_seller_and_price_from_buybox(self):
        html = '''
        <span id="productTitle">Spontex Heavy Duty Scourer Pads with Stop Grease, Pack of 6</span>
        <div id="tabular-buybox">
          <div class="tabular-buybox-text"><span>Shipper / Seller</span><span>Amazon</span></div>
          <div class="a-price"><span class="a-offscreen">£7.68</span></div>
        </div>
        '''

        details = extract_amazon_product_details(html)

        self.assertEqual(details["seller"], "Amazon")
        self.assertEqual(details["price"], "£7.68")

    def test_offer_lookup_returns_full_listing_details(self):
        html = '''
        <span id="productTitle">Spontex Heavy Duty Scourer Pads, Pack of 3</span>
        <a id="sellerProfileTriggerId">Amazon.co.uk</a>
        <div id="corePrice_feature_div"><span class="a-offscreen">£2.49</span></div>
        '''

        with patch("main.fetch_amazon_page", return_value=html) as fetch:
            result = get_amazon_offer(AmazonOfferRequest(asin="B012345678"))

        fetch.assert_called_once_with(
            "https://www.amazon.co.uk/dp/B012345678",
            "The Amazon UK listing details could not be reached. Try again later.",
        )
        self.assertEqual(result["status"], "found")
        self.assertEqual(result["amazonTitle"], "Spontex Heavy Duty Scourer Pads, Pack of 3")
        self.assertEqual(result["seller"], "Amazon.co.uk")
        self.assertEqual(result["price"], "£2.49")

    def test_seller_parser_extracts_marketplace_seller_from_merchant_summary(self):
        seller = extract_seller_name("Dispatches from Amazon. Sold by: Green Shop and dispatched from Amazon")

        self.assertEqual(seller, "Green Shop")

    def test_offer_request_normalizes_and_validates_asin(self):
        request = AmazonOfferRequest(asin="b01btku7e8")

        self.assertEqual(request.asin, "B01BTKU7E8")
        with self.assertRaises(ValueError):
            AmazonOfferRequest(asin="https://example.com")

    def test_search_result_parser_recovers_asin_from_product_link(self):
        html = '''
        <div data-component-type="s-search-result" data-asin="">
          <h2><a href="/gp/aw/d/B012345678"><span>Northstar Hand Cream 250ml</span></a></h2>
          <img class="s-image" src="https://m.media-amazon.com/images/I/example.jpg" />
        </div>
        <div data-component-type="s-search-result" data-asin="">
          <h2><a href="/sspa/click?url=%2Fdp%2FB012345679"><span>Northstar Hand Cream 300ml</span></a></h2>
          <img class="s-image" src="https://m.media-amazon.com/images/I/example.jpg" />
        </div>
        '''

        results = extract_amazon_candidates(html, "")

        self.assertEqual(results[0]["asin"], "B012345678")
        self.assertEqual(results[0]["productUrl"], "https://www.amazon.co.uk/dp/B012345678")
        self.assertEqual(results[1]["asin"], "B012345679")
        self.assertEqual(results[1]["productUrl"], "https://www.amazon.co.uk/dp/B012345679")

    def test_lookup_retains_top_five_options_with_low_title_similarity(self):
        candidates = [
            {
                "asin": f"B000LOW00{index}",
                "title": f"Imperial Radox Body Wash Option {index}",
                "cardText": f"Imperial Radox Body Wash Option {index}",
                "imageUrl": "https://m.media-amazon.com/images/I/example.jpg",
                "productUrl": f"https://www.amazon.co.uk/dp/B000LOW00{index}",
                "price": "£2.00",
            }
            for index in range(1, 6)
        ]
        product = MatchRequest(title="Imperial Leather Bath Muscle Soak Bergamot Sensitive Aloe Botanical")

        with patch("main.search_amazon", return_value=candidates), patch("main.get_regal_image", return_value=""):
            result = match_product(product)

        self.assertEqual(len(result["candidates"]), 5)
        self.assertEqual(result["status"], "low")
        self.assertTrue(all(candidate["tier"] == "low" for candidate in result["candidates"]))

    def test_lookup_collects_up_to_five_visual_choices(self):
        candidates = [
            {
                "asin": f"B00000000{index}",
                "title": f"Northstar Antibacterial Hand Wash Variant {index}",
                "cardText": f"Northstar Antibacterial Hand Wash Variant {index}",
                "imageUrl": "https://m.media-amazon.com/images/I/example.jpg",
                "productUrl": f"https://www.amazon.co.uk/dp/B00000000{index}",
                "price": "£2.00",
            }
            for index in range(1, 6)
        ]
        product = MatchRequest(title="Antibacterial Hand Wash", brand="Northstar", category="soap_hygiene")

        with patch("main.search_amazon", return_value=candidates), patch("main.get_regal_image", return_value=""):
            result = match_product(product)

        self.assertEqual(len(result["candidates"]), 5)
        self.assertEqual(result["bestCandidate"]["asin"], "B000000001")

    def test_active_amazon_block_prevents_followup_requests(self):
        with patch("main._amazon_blocked_until", time.monotonic() + 60), patch("main.requests.Session") as session:
            with self.assertRaises(AmazonBlocked):
                search_amazon("Northstar Gentle Soap", "")

        session.assert_not_called()

if __name__ == "__main__":
    unittest.main()
